import type { Prisma, UserSettings } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../config/prisma";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service";
import { ValidationError } from "../../utils/errors";

/**
 * User settings + privacy surface.
 *
 * Settings are the user's control panel over everything the agent does, so the
 * update schema is strict: unknown keys are rejected and every escalation timer
 * is bounded. Nothing here can be widened by a client beyond safe limits.
 */

export const settingsPatchSchema = z
  .object({
    // Account
    name: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),

    // Scanning
    scanIntervalMinutes: z.coerce.number().int().min(15).max(1440).optional(),
    scanningEnabled: z.boolean().optional(),

    // Channels
    notifyDashboard: z.boolean().optional(),
    notifySlack: z.boolean().optional(),
    notifyWhatsapp: z.boolean().optional(),
    notifyEmail: z.boolean().optional(),
    notifyVoice: z.boolean().optional(),
    notifyMinSeverity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),

    // Escalation
    escalationEnabled: z.boolean().optional(),
    escalationDelaysMinutes: z.array(z.coerce.number().int().min(1).max(1440)).min(1).max(5).optional(),
    escalationMaxStage: z.coerce.number().int().min(0).max(2).optional(),

    // Voice
    voiceEnabled: z.boolean().optional(),
    voiceMaxCallsPerDay: z.coerce.number().int().min(0).max(10).optional(),
    voiceQuietHoursStart: z.coerce.number().int().min(0).max(23).optional(),
    voiceQuietHoursEnd: z.coerce.number().int().min(0).max(23).optional(),
    voiceCriticalEvents: z.array(z.enum(["OFFER", "INTERVIEW", "ASSESSMENT", "RECRUITER_ACTION", "DEADLINE_APPROACHING"])).max(5).optional(),

    // Cleanup
    autoCleanupEnabled: z.boolean().optional(),
    cleanupCategories: z.array(z.enum(["PROMOTIONAL", "SPAM", "NEWSLETTER", "OTHER"])).max(4).optional(),
    protectJobEmails: z.boolean().optional(),
    protectPersonal: z.boolean().optional(),
    protectFinancial: z.boolean().optional(),
    protectGovernment: z.boolean().optional(),

    // Privacy
    storeEmailBody: z.boolean().optional(),
    dataRetentionDays: z.coerce.number().int().min(7).max(3650).optional(),
    redactSensitiveLogs: z.boolean().optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export async function getOrCreateSettings(userId: string): Promise<UserSettings> {
  const existing = await prisma.userSettings.findUnique({ where: { userId } });
  if (existing) return existing;
  return prisma.userSettings.create({ data: { userId } });
}

export async function updateSettings(userId: string, patch: SettingsPatch): Promise<UserSettings> {
  await getOrCreateSettings(userId);

  const settingsData: Prisma.UserSettingsUpdateInput = {};
  const userData: Prisma.UserUpdateInput = {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "name" || key === "timezone") {
      (userData as Record<string, unknown>)[key] = value;
    } else {
      (settingsData as Record<string, unknown>)[key] = value;
    }
  }

  // Cross-field guards that a per-field schema cannot express.
  if (settingsData.voiceEnabled === true) {
    const current = await prisma.userSettings.findUnique({ where: { userId } });
    const willAcceptCalls = patch.notifyVoice ?? current?.notifyVoice ?? false;
    if (!willAcceptCalls) {
      // Enabling calls without the voice channel would be a silent no-op; make it
      // explicit by also enabling the channel rather than confusing the user.
      settingsData.notifyVoice = true;
    }
  }

  if (settingsData.voiceQuietHoursStart !== undefined && settingsData.voiceQuietHoursEnd !== undefined) {
    if (settingsData.voiceQuietHoursStart === settingsData.voiceQuietHoursEnd) {
      throw new ValidationError("Quiet hours start and end must differ (leave a window open for urgent calls)");
    }
  }

  const [settings] = await prisma.$transaction([
    prisma.userSettings.upsert({
      where: { userId },
      create: { userId, ...(settingsData as object) },
      update: settingsData,
    }),
    ...(Object.keys(userData).length
      ? [prisma.user.update({ where: { id: userId }, data: userData })]
      : []),
  ]);

  await recordAudit({
    userId,
    actor: "USER",
    action: AUDIT_ACTIONS.settingsUpdated,
    entityType: "UserSettings",
    entityId: settings.id,
    summary: "Settings updated",
    metadata: { fields: Object.keys(patch) },
  });

  return settings;
}

export interface PrivacySummary {
  gmailAccounts: Array<{
    id: string;
    emailAddress: string;
    status: string;
    scopes: string[];
    lastSyncAt: string | null;
    historyId: string | null;
  }>;
  dataStored: {
    emails: number;
    emailBodiesStored: number;
    analyses: number;
    applications: number;
    applicationEvents: number;
    notifications: number;
    cleanupActions: number;
    auditLogs: number;
  };
  retention: {
    storeEmailBody: boolean;
    dataRetentionDays: number;
    oldestEmailAt: string | null;
  };
  controls: Array<{ id: string; label: string; description: string; endpoint: string; method: string }>;
  aiProcessing: {
    provider: string;
    /** Content sent to the provider for analysis. */
    sendsEmailContent: boolean;
    retainsPromptData: false;
  };
}

/**
 * Everything the user needs in order to understand what MailOps holds and how to
 * get rid of it (product spec #28). Deliberately verbose and literal.
 */
export async function getPrivacySummary(userId: string): Promise<PrivacySummary> {
  const [
    settings,
    accounts,
    emails,
    bodiesStored,
    analyses,
    applications,
    events,
    notifications,
    cleanup,
    audit,
    oldest,
  ] = await Promise.all([
    getOrCreateSettings(userId),
    prisma.gmailAccount.findMany({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.email.count({ where: { userId } }),
    prisma.email.count({ where: { userId, bodyText: { not: null } } }),
    prisma.emailAnalysis.count({ where: { userId } }),
    prisma.application.count({ where: { userId } }),
    prisma.applicationEvent.count({ where: { userId } }),
    prisma.notification.count({ where: { userId } }),
    prisma.cleanupAction.count({ where: { userId } }),
    prisma.auditLog.count({ where: { userId } }),
    prisma.email.findFirst({ where: { userId }, orderBy: { receivedAt: "asc" }, select: { receivedAt: true } }),
  ]);

  return {
    gmailAccounts: accounts.map((account) => ({
      id: account.id,
      emailAddress: account.emailAddress,
      status: account.status,
      scopes: account.grantedScopes,
      lastSyncAt: account.lastSyncAt ? account.lastSyncAt.toISOString() : null,
      historyId: account.historyId,
    })),
    dataStored: {
      emails,
      emailBodiesStored: bodiesStored,
      analyses,
      applications,
      applicationEvents: events,
      notifications,
      cleanupActions: cleanup,
      auditLogs: audit,
    },
    retention: {
      storeEmailBody: settings.storeEmailBody,
      dataRetentionDays: settings.dataRetentionDays,
      oldestEmailAt: oldest?.receivedAt ? oldest.receivedAt.toISOString() : null,
    },
    controls: [
      {
        id: "disconnect-gmail",
        label: "Disconnect Gmail",
        description: "Revokes MailOps' Google access and deletes the stored OAuth tokens. Your emails stay untouched in Gmail.",
        endpoint: "/api/gmail/disconnect",
        method: "POST",
      },
      {
        id: "delete-email-data",
        label: "Delete stored email data",
        description: "Permanently removes every email and analysis MailOps stored. Optionally keeps your application history.",
        endpoint: "/api/privacy/email-data",
        method: "DELETE",
      },
      {
        id: "export-data",
        label: "Export my data",
        description: "Downloads everything MailOps knows about you as JSON.",
        endpoint: "/api/privacy/export",
        method: "GET",
      },
      {
        id: "retention",
        label: "Change retention window",
        description: "MailOps trims email bodies and purges unlinked emails older than this window automatically.",
        endpoint: "/api/settings",
        method: "PATCH",
      },
    ],
    aiProcessing: {
      provider: "configured AI provider (see admin configuration)",
      sendsEmailContent: true,
      retainsPromptData: false,
    },
  };
}

/** Full data export for GDPR-style portability. */
export async function exportUserData(userId: string) {
  const [user, settings, applications, events, analyses, notifications, auditLogs, accounts, cleanupActions] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, timezone: true, createdAt: true } }),
      prisma.userSettings.findUnique({ where: { userId } }),
      prisma.application.findMany({ where: { userId }, include: { events: { orderBy: { occurredAt: "asc" } } } }),
      prisma.applicationEvent.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } }),
      prisma.emailAnalysis.findMany({
        where: { userId },
        select: {
          id: true,
          emailId: true,
          category: true,
          subCategory: true,
          priority: true,
          confidence: true,
          summary: true,
          reasoning: true,
          extracted: true,
          createdAt: true,
        },
      }),
      prisma.notification.findMany({
        where: { userId },
        select: {
          id: true,
          type: true,
          severity: true,
          title: true,
          body: true,
          status: true,
          requiresAck: true,
          acknowledgedAt: true,
          createdAt: true,
        },
      }),
      prisma.auditLog.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 2000 }),
      prisma.gmailAccount.findMany({
        where: { userId },
        select: { id: true, emailAddress: true, status: true, grantedScopes: true, lastSyncAt: true, createdAt: true },
      }),
      prisma.cleanupAction.findMany({ where: { userId }, select: { id: true, type: true, status: true, category: true, createdAt: true, executedAt: true } }),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    notice:
      "Email bodies are intentionally excluded from this export because MailOps stores them only as minimised text for analysis. Disconnect and delete stored email data if you want them removed.",
    user,
    settings,
    gmailAccounts: accounts,
    applications,
    applicationEvents: events,
    emailAnalyses: analyses,
    notifications,
    cleanupActions,
    auditLogs,
  };
}
