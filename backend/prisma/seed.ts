/**
 * Development seed data.
 *
 * Everything produced here is labelled `isDemo: true` so the UI can badge it and
 * so a real account never confuses demo rows with its own data.
 *
 * The seed intentionally writes through Prisma directly rather than through the
 * service layer: it must run with no Redis, no AI provider and no Google
 * credentials, and it must be deterministic.
 *
 * Usage:
 *   npm run seed                        # seeds the demo account
 *   SEED_RESET=true npm run seed        # wipes and re-seeds the demo account
 */
import path from "node:path";
import dotenv from "dotenv";
import { PrismaClient, type ApplicationStatus, type Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

/**
 * Load backend/.env explicitly.
 *
 * `npm run seed` executes `tsx prisma/seed.ts` directly, which bypasses the
 * Prisma CLI — and the CLI is what normally loads .env ("Environment variables
 * loaded from .env"). The generated Prisma 5 client does not read .env by itself,
 * so without this the client fails at construction with
 * "Environment variable not found: DATABASE_URL".
 *
 * Dotenv never overwrites an already-set variable, so real environment values
 * still take precedence. Both candidate locations are loaded so the script works
 * whether it is run from the backend directory or the repository root.
 */
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const prisma = new PrismaClient();

const DEMO_EMAIL = process.env.SEED_EMAIL ?? "demo@mailops.local";
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "MailOpsDemo123";
const RESET = process.env.SEED_RESET === "true";

/** Deterministic PRNG so repeated seeds produce the same dashboard. */
let seedState = 20260921;
function random(): number {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}
function daysAgo(days: number, hourOffset = 9): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(hourOffset, Math.floor(random() * 59), 0, 0);
  return date;
}

const COMPANIES = [
  "Microsoft",
  "Google",
  "Amazon",
  "Deloitte",
  "TCS",
  "Infosys",
  "Accenture",
  "Wipro",
  "Cognizant",
  "Salesforce",
] as const;

const ROLES = [
  "Software Engineer",
  "Backend Engineer",
  "Data Analyst",
  "Business Analyst",
  "Cloud Engineer",
  "Frontend Engineer",
  "DevOps Engineer",
  "Product Analyst",
] as const;

const LOCATIONS = ["Hyderabad", "Bengaluru", "Pune", "Remote", "Chennai", "Noida", "Gurugram"] as const;

interface PlannedApplication {
  company: string;
  role: string;
  jobId: string;
  location: string;
  status: string;
  appliedDaysAgo: number;
  timeline: Array<{ type: string; title: string; daysAgo: number; dueDaysAgo?: number; confidence?: number }>;
}

/** Hand-authored story beats so the timeline reads like a real job search. */
const APPLICATION_PLAN: PlannedApplication[] = [
  {
    company: "Microsoft",
    role: "Software Engineer",
    jobId: "MS-98231",
    location: "Hyderabad",
    status: "INTERVIEW",
    appliedDaysAgo: 13,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 13 },
      { type: "STATUS_CHANGED", title: "Application acknowledged", daysAgo: 11 },
      { type: "STATUS_CHANGED", title: "Shortlisted", daysAgo: 9 },
      { type: "ASSESSMENT_ASSIGNED", title: "Online assessment received", daysAgo: 7, dueDaysAgo: -2 },
      { type: "INTERVIEW_SCHEDULED", title: "Technical interview invitation", daysAgo: 5, dueDaysAgo: -4 },
      { type: "ACTION_REQUIRED", title: "Action required: confirm interview slot", daysAgo: 5, dueDaysAgo: -4 },
    ],
  },
  {
    company: "Google",
    role: "Backend Engineer",
    jobId: "GOOG-4410",
    location: "Bengaluru",
    status: "ASSESSMENT",
    appliedDaysAgo: 10,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 10 },
      { type: "STATUS_CHANGED", title: "Shortlisted", daysAgo: 6 },
      { type: "ASSESSMENT_ASSIGNED", title: "Coding challenge received", daysAgo: 4, dueDaysAgo: 3 },
    ],
  },
  {
    company: "Amazon",
    role: "Cloud Engineer",
    jobId: "AMZ-7781",
    location: "Remote",
    status: "OFFER",
    appliedDaysAgo: 24,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 24 },
      { type: "STATUS_CHANGED", title: "Shortlisted", daysAgo: 20 },
      { type: "INTERVIEW_SCHEDULED", title: "Loop interviews scheduled", daysAgo: 14 },
      { type: "OFFER_ISSUED", title: "Offer issued", daysAgo: 3, dueDaysAgo: 6 },
      { type: "ACTION_REQUIRED", title: "Action required: respond to offer", daysAgo: 3, dueDaysAgo: 6 },
    ],
  },
  {
    company: "Deloitte",
    role: "Business Analyst",
    jobId: "DEL-2210",
    location: "Pune",
    status: "REJECTED",
    appliedDaysAgo: 33,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 33 },
      { type: "STATUS_CHANGED", title: "Application acknowledged", daysAgo: 31 },
      { type: "STATUS_CHANGED", title: "Shortlisted", daysAgo: 26 },
      { type: "INTERVIEW_SCHEDULED", title: "HR interview scheduled", daysAgo: 19 },
      { type: "REJECTION_RECEIVED", title: "Application not selected", daysAgo: 8 },
    ],
  },
  {
    company: "TCS",
    role: "Data Analyst",
    jobId: "TCS-90211",
    location: "Chennai",
    status: "SHORTLISTED",
    appliedDaysAgo: 8,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 8 },
      { type: "STATUS_CHANGED", title: "Application acknowledged", daysAgo: 7 },
      { type: "STATUS_CHANGED", title: "Shortlisted", daysAgo: 3 },
    ],
  },
  {
    company: "Infosys",
    role: "DevOps Engineer",
    jobId: "INF-5512",
    location: "Bengaluru",
    status: "ACKNOWLEDGED",
    appliedDaysAgo: 6,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 6 },
      { type: "STATUS_CHANGED", title: "Application acknowledged", daysAgo: 5 },
    ],
  },
  {
    company: "Accenture",
    role: "Frontend Engineer",
    jobId: "ACN-3319",
    location: "Hyderabad",
    status: "APPLIED",
    appliedDaysAgo: 4,
    timeline: [{ type: "APPLICATION_CREATED", title: "Application created", daysAgo: 4 }],
  },
  {
    company: "Wipro",
    role: "Product Analyst",
    jobId: "WIP-8802",
    location: "Noida",
    status: "REJECTED",
    appliedDaysAgo: 41,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 41 },
      { type: "REJECTION_RECEIVED", title: "Application not selected", daysAgo: 29 },
    ],
  },
  {
    company: "Cognizant",
    role: "Software Engineer",
    jobId: "CTS-1174",
    location: "Gurugram",
    status: "FINAL_ROUND",
    appliedDaysAgo: 18,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 18 },
      { type: "STATUS_CHANGED", title: "Shortlisted", daysAgo: 14 },
      { type: "INTERVIEW_SCHEDULED", title: "Technical round scheduled", daysAgo: 10 },
      { type: "INTERVIEW_SCHEDULED", title: "Final round invitation", daysAgo: 2, dueDaysAgo: 1 },
    ],
  },
  {
    company: "Salesforce",
    role: "Backend Engineer",
    jobId: "SF-6603",
    location: "Hyderabad",
    status: "APPLIED",
    appliedDaysAgo: 2,
    timeline: [{ type: "APPLICATION_CREATED", title: "Application created", daysAgo: 2 }],
  },
  {
    company: "Microsoft",
    role: "Data Analyst",
    jobId: "MS-98104",
    location: "Bengaluru",
    status: "ACKNOWLEDGED",
    appliedDaysAgo: 5,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 5 },
      { type: "STATUS_CHANGED", title: "Application acknowledged", daysAgo: 4 },
    ],
  },
  {
    company: "Amazon",
    role: "Data Analyst",
    jobId: "AMZ-7745",
    location: "Remote",
    status: "NO_RESPONSE",
    appliedDaysAgo: 52,
    timeline: [{ type: "APPLICATION_CREATED", title: "Application created", daysAgo: 52 }],
  },
  {
    company: "Google",
    role: "Software Engineer",
    jobId: "GOOG-4388",
    location: "Bengaluru",
    status: "REJECTED",
    appliedDaysAgo: 60,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 60 },
      { type: "STATUS_CHANGED", title: "Application acknowledged", daysAgo: 58 },
      { type: "REJECTION_RECEIVED", title: "Application not selected", daysAgo: 47 },
    ],
  },
  {
    company: "Deloitte",
    role: "Data Analyst",
    jobId: "DEL-2187",
    location: "Hyderabad",
    status: "INTERVIEW",
    appliedDaysAgo: 15,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 15 },
      { type: "STATUS_CHANGED", title: "Shortlisted", daysAgo: 11 },
      { type: "INTERVIEW_SCHEDULED", title: "Technical interview invitation", daysAgo: 4, dueDaysAgo: 2 },
    ],
  },
  {
    company: "TCS",
    role: "Software Engineer",
    jobId: "TCS-90188",
    location: "Pune",
    status: "WITHDRAWN",
    appliedDaysAgo: 27,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 27 },
      { type: "WITHDRAWN", title: "You withdrew this application", daysAgo: 21 },
    ],
  },
  {
    company: "Accenture",
    role: "Cloud Engineer",
    jobId: "ACN-3301",
    location: "Chennai",
    status: "SHORTLISTED",
    appliedDaysAgo: 12,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 12 },
      { type: "STATUS_CHANGED", title: "Shortlisted", daysAgo: 5 },
    ],
  },
  {
    company: "Cognizant",
    role: "DevOps Engineer",
    jobId: "CTS-1160",
    location: "Hyderabad",
    status: "ON_HOLD",
    appliedDaysAgo: 22,
    timeline: [
      { type: "APPLICATION_CREATED", title: "Application created", daysAgo: 22 },
      { type: "STATUS_CHANGED", title: "Shortlisted", daysAgo: 17 },
      { type: "STATUS_CHANGED", title: "Process paused by the employer", daysAgo: 9 },
    ],
  },
  {
    company: "Salesforce",
    role: "Product Analyst",
    jobId: "SF-6588",
    location: "Remote",
    status: "APPLIED",
    appliedDaysAgo: 1,
    timeline: [{ type: "APPLICATION_CREATED", title: "Application created", daysAgo: 1 }],
  },
];

function normalizeCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(inc|inc\.|ltd|ltd\.|limited|technologies|technology|tech|solutions|systems|services|group|software|consulting|global|india)\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRole(role: string): string {
  return role
    .toLowerCase()
    .replace(/\b(senior|sr|junior|jr|lead|staff|principal|full|part|time|remote|hybrid|onsite)\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resetDemoData(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.applicationEvent.deleteMany({ where: { userId } }),
    prisma.notificationAttempt.deleteMany({ where: { notification: { userId } } }),
    prisma.notification.deleteMany({ where: { userId } }),
    prisma.emailAnalysis.deleteMany({ where: { userId } }),
    prisma.cleanupAction.deleteMany({ where: { userId } }),
    prisma.email.deleteMany({ where: { userId } }),
    prisma.application.deleteMany({ where: { userId } }),
    prisma.scanJob.deleteMany({ where: { userId } }),
    prisma.auditLog.deleteMany({ where: { userId } }),
    prisma.gmailAccount.deleteMany({ where: { userId } }),
  ]);
}

async function main(): Promise<void> {
  console.log("Seeding MailOps demo data…");

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    create: {
      email: DEMO_EMAIL,
      name: "Demo Candidate",
      passwordHash,
      timezone: "Asia/Kolkata",
      isDemo: true,
      settings: {
        create: {
          scanIntervalMinutes: 210,
          scanningEnabled: true,
          notifyDashboard: true,
          notifySlack: true,
          notifyWhatsapp: true,
          notifyEmail: false,
          notifyVoice: false,
          notifyMinSeverity: "MEDIUM",
          escalationDelaysMinutes: [30, 60, 120],
          escalationEnabled: true,
          escalationMaxStage: 2,
          voiceEnabled: false,
          voiceMaxCallsPerDay: 2,
          voiceQuietHoursStart: 22,
          voiceQuietHoursEnd: 7,
          voiceCriticalEvents: ["OFFER", "INTERVIEW", "ASSESSMENT", "RECRUITER_ACTION"],
          autoCleanupEnabled: false,
          cleanupCategories: ["PROMOTIONAL", "SPAM", "NEWSLETTER"],
          storeEmailBody: true,
          dataRetentionDays: 365,
        },
      },
    },
    update: { name: "Demo Candidate", isDemo: true },
    include: { settings: true },
  });

  /**
   * Always clear the demo account's derived rows before seeding.
   *
   * The seed is meant to be deterministic and repeatable. Without this, a second
   * `npm run seed` aborts on the (userId, gmailMessageId) unique constraint and
   * leaves a half-populated dataset behind, so the documented command was only
   * safe against a fresh database. Only rows belonging to the demo account are
   * removed. SEED_RESET is still accepted for backwards compatibility.
   */
  console.log(
    RESET
      ? "SEED_RESET=true — clearing existing demo data…"
      : "Replacing existing demo data so repeated runs stay deterministic…",
  );
  await resetDemoData(user.id);

  // --- Integrations ---------------------------------------------------------
  const integrationPlan: Array<{ kind: "SLACK" | "WHATSAPP" | "VOICE" | "EMAIL" | "AI"; status: "CONNECTED" | "DISCONNECTED"; displayName: string; config?: Record<string, unknown> }> = [
    { kind: "SLACK", status: "CONNECTED", displayName: "#job-search", config: { channel: "#job-search" } },
    { kind: "WHATSAPP", status: "CONNECTED", displayName: "+91 98*****21", config: { to: "+919800000021" } },
    { kind: "VOICE", status: "DISCONNECTED", displayName: null as unknown as string },
    { kind: "EMAIL", status: "CONNECTED", displayName: DEMO_EMAIL },
    { kind: "AI", status: "CONNECTED", displayName: "heuristic" },
  ];

  for (const integration of integrationPlan) {
    await prisma.integration.upsert({
      where: { userId_kind: { userId: user.id, kind: integration.kind } },
      create: {
        userId: user.id,
        kind: integration.kind,
        status: integration.status,
        displayName: integration.displayName ?? null,
        config: (integration.config ?? {}) as Prisma.InputJsonValue,
      },
      update: {
        status: integration.status,
        displayName: integration.displayName ?? null,
        config: (integration.config ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  // --- Gmail account (demo, no credentials) ---------------------------------
  const gmailAccount = await prisma.gmailAccount.upsert({
    where: { userId_emailAddress: { userId: user.id, emailAddress: "demo.candidate@gmail.com" } },
    create: {
      userId: user.id,
      emailAddress: "demo.candidate@gmail.com",
      status: "DISCONNECTED",
      grantedScopes: [],
      historyId: "demo-history-20260921",
      lastSyncAt: daysAgo(0, 6),
    },
    update: { lastSyncAt: daysAgo(0, 6) },
  });

  // --- Applications + timeline ---------------------------------------------
  const applicationRecords: Array<{ id: string; company: string; role: string; jobId: string; status: string }> = [];

  for (const plan of APPLICATION_PLAN) {
    const appliedDate = daysAgo(plan.appliedDaysAgo);
    const lastEvent = plan.timeline[plan.timeline.length - 1];

    const application = await prisma.application.create({
      data: {
        userId: user.id,
        company: plan.company,
        role: plan.role,
        jobId: plan.jobId,
        location: plan.location,
        employmentType: "Full-time",
        source: `email:careers@${plan.company.toLowerCase()}.com`,
        applicationUrl: `https://careers.${plan.company.toLowerCase()}.com/apply/${plan.jobId}`,
        jobUrl: `https://careers.${plan.company.toLowerCase()}.com/jobs/${plan.jobId}`,
        recruiterName: pick(["Priya Nair", "Rahul Verma", "Anita Sharma", "James Cooper", "Meera Iyer"]),
        recruiterEmail: `talent@${plan.company.toLowerCase()}.com`,
        appliedDate,
        status: plan.status as never,
        statusChangedAt: daysAgo(lastEvent.daysAgo),
        lastEmailAt: daysAgo(lastEvent.daysAgo),
        companyKey: normalizeCompany(plan.company),
        roleKey: normalizeRole(plan.role),
        confidence: 0.86 + random() * 0.1,
        isDemo: true,
        notes: "Seeded demo record — this is not a real application.",
      },
    });

    applicationRecords.push({
      id: application.id,
      company: plan.company,
      role: plan.role,
      jobId: plan.jobId,
      status: plan.status,
    });

    for (let index = 0; index < plan.timeline.length; index += 1) {
      const step = plan.timeline[index];
      const previous = plan.timeline[index - 1];

      await prisma.applicationEvent.create({
        data: {
          applicationId: application.id,
          userId: user.id,
          type: step.type as never,
          actor: index === 0 || step.type !== "USER_OVERRIDE" ? "AI" : "USER",
          title: step.title,
          description:
            step.type === "ACTION_REQUIRED"
              ? "The employer is waiting on you. MailOps will escalate if this is not actioned."
              : step.type === "REJECTION_RECEIVED"
                ? "The employer closed this application. The history has been kept even if the email is deleted."
                : `Milestone recorded from an email on ${daysAgo(step.daysAgo).toISOString().slice(0, 10)}.`,
          fromStatus: previous ? (previous.type === "APPLICATION_CREATED" ? "APPLIED" : null) : null,
          toStatus: statusFromEventType(step.type),
          occurredAt: daysAgo(step.daysAgo),
          dueAt: step.dueDaysAgo !== undefined ? daysAgo(step.dueDaysAgo) : null,
          confidence: step.confidence ?? 0.88 + random() * 0.1,
          isDemo: true,
          metadata: { seeded: true, step: step.type } as Prisma.InputJsonValue,
        },
      });
    }
  }

  // --- Emails + analyses ----------------------------------------------------
  const jobEmails: Array<{ id: string; applicationId: string; subCategory: string; category: string }> = [];

  for (const application of applicationRecords) {
    const mapping = emailForStatus(application.status);
    if (!mapping) continue;

    const receivedAt = daysAgo(mapping.daysAgo);
    const email = await prisma.email.create({
      data: {
        userId: user.id,
        gmailAccountId: gmailAccount.id,
        gmailMessageId: `demo-msg-${application.jobId}-${mapping.subCategory}`,
        gmailThreadId: `demo-thread-${application.jobId}`,
        fromName: `${application.company} Careers`,
        fromEmail: `careers@${application.company.toLowerCase()}.com`,
        toEmail: "demo.candidate@gmail.com",
        subject: mapping.subject.replace("{role}", application.role),
        snippet: mapping.summary.replace("{company}", application.company).slice(0, 200),
        bodyText: mapping.body.replace(/{company}/g, application.company).replace(/{role}/g, application.role),
        receivedAt,
        labels: ["INBOX", "CATEGORY_UPDATES"],
        hasAttachments: false,
        sizeEstimate: 42_000 + Math.floor(random() * 20_000),
        isImportant: ["SHORTLISTED", "ASSESSMENT", "INTERVIEW", "FINAL_ROUND", "OFFER"].includes(mapping.subCategory),
        isUnread: false,
        processingState: "PROCESSED",
        processedAt: receivedAt,
        attempts: 1,
        applicationId: application.id,
        threadKey: mapping.subCategory.toLowerCase(),
        createdAt: receivedAt,
      },
    });

    await prisma.emailAnalysis.create({
      data: {
        emailId: email.id,
        userId: user.id,
        category: "JOB",
        subCategory: mapping.subCategory as never,
        priority: mapping.priority as never,
        confidence: 0.9 + random() * 0.08,
        requiresAction: mapping.requiresAction,
        needsReview: false,
        reasoning: mapping.reasoning,
        summary: mapping.summary.replace("{company}", application.company).replace("{role}", application.role),
        extracted: {
          company: application.company,
          role: application.role,
          jobId: application.jobId,
          applicationStatus: statusFromSubCategory(mapping.subCategory),
          deadline: mapping.deadlineDaysAgo !== undefined ? daysAgo(mapping.deadlineDaysAgo).toISOString() : null,
          recruiterEmail: `talent@${application.company.toLowerCase()}.com`,
          requiredAction: mapping.requiredAction,
          evidence: mapping.summary.replace("{company}", application.company),
        } as Prisma.InputJsonValue,
        isUnwanted: false,
        model: "heuristic:classifier@1.3.0",
        provider: "heuristic",
        promptVersion: "classifier@1.3.0",
        latencyMs: 12 + Math.floor(random() * 40),
        tokenUsage: {} as Prisma.InputJsonValue,
        createdAt: receivedAt,
      },
    });

    jobEmails.push({ id: email.id, applicationId: application.id, subCategory: mapping.subCategory, category: "JOB" });
  }

  // Non-job mail for the cleanup demo.
  const noiseEmails: Array<{ category: string; sender: string; subject: string; daysAgo: number; unwanted: boolean }> = [
    { category: "PROMOTIONAL", sender: "deals@shopmart.com", subject: "Mega sale — flat 60% off everything", daysAgo: 1, unwanted: true },
    { category: "PROMOTIONAL", sender: "offers@fashionhub.in", subject: "Limited time offer: buy 2 get 1 free", daysAgo: 2, unwanted: true },
    { category: "PROMOTIONAL", sender: "deals@travelmate.com", subject: "Weekend flight deals you cannot miss", daysAgo: 3, unwanted: true },
    { category: "PROMOTIONAL", sender: "hello@foodrush.com", subject: "₹150 off your next order — order now", daysAgo: 4, unwanted: true },
    { category: "PROMOTIONAL", sender: "marketing@gadgetworld.com", subject: "Add to cart: new arrivals at best price", daysAgo: 5, unwanted: true },
    { category: "NEWSLETTER", sender: "digest@techweekly.com", subject: "Weekly digest — issue #212", daysAgo: 2, unwanted: true },
    { category: "NEWSLETTER", sender: "news@dailystack.dev", subject: "This week in backend engineering", daysAgo: 6, unwanted: true },
    { category: "NEWSLETTER", sender: "editor@productbytes.io", subject: "Monthly roundup: what shipped in September", daysAgo: 9, unwanted: true },
    { category: "SPAM", sender: "winner@lucky-draw.biz", subject: "You have won $500,000 — claim your prize", daysAgo: 2, unwanted: true },
    { category: "SPAM", sender: "crypto@gainfast-invest.net", subject: "Bitcoin investment — 100% guaranteed returns", daysAgo: 4, unwanted: true },
    { category: "SPAM", sender: "hr@home-earn-quick.com", subject: "Work from home and earn ₹50,000 weekly", daysAgo: 7, unwanted: true },
    { category: "SOCIAL", sender: "notifications@linkedin.com", subject: "You have 12 new connection requests", daysAgo: 1, unwanted: true },
    { category: "SOCIAL", sender: "no-reply@facebookmail.com", subject: "A friend mentioned you in a post", daysAgo: 5, unwanted: true },
    { category: "PERSONAL", sender: "arjun.menon@gmail.com", subject: "Re: Weekend plans?", daysAgo: 3, unwanted: false },
    { category: "TRANSACTIONAL", sender: "alerts@hdfcbank.com", subject: "Transaction alert: ₹2,499 debited", daysAgo: 2, unwanted: false },
  ];

  let promotedCount = 0;
  let spamCount = 0;
  let newsletterCount = 0;

  for (const noise of noiseEmails) {
    const receivedAt = daysAgo(noise.daysAgo, 11);
    const email = await prisma.email.create({
      data: {
        userId: user.id,
        gmailAccountId: gmailAccount.id,
        gmailMessageId: `demo-noise-${noise.category}-${noise.daysAgo}-${noise.sender}`,
        gmailThreadId: `demo-thread-noise-${noise.sender}`,
        fromName: noise.sender.split("@")[0],
        fromEmail: noise.sender,
        toEmail: "demo.candidate@gmail.com",
        subject: noise.subject,
        snippet: noise.subject,
        bodyText: `${noise.subject}. Unsubscribe from this list. This is seeded demo content.`,
        receivedAt,
        labels: ["INBOX", "CATEGORY_PROMOTIONS"],
        hasAttachments: false,
        sizeEstimate: 30_000,
        isImportant: false,
        isUnread: true,
        processingState: "PROCESSED",
        processedAt: receivedAt,
        attempts: 1,
        threadKey: noise.subject.toLowerCase().slice(0, 40),
        createdAt: receivedAt,
      },
    });

    await prisma.emailAnalysis.create({
      data: {
        emailId: email.id,
        userId: user.id,
        category: noise.category as never,
        subCategory: null,
        priority: "LOW",
        confidence: 0.82 + random() * 0.14,
        requiresAction: false,
        needsReview: false,
        reasoning: noise.unwanted ? "Bulk marketing content with an unsubscribe footer." : "Non-recruitment message.",
        summary: noise.subject,
        extracted: {} as Prisma.InputJsonValue,
        isUnwanted: noise.unwanted,
        unwantedReason: noise.unwanted ? "Promotional bulk mail" : null,
        model: "heuristic:classifier@1.3.0",
        provider: "heuristic",
        promptVersion: "classifier@1.3.0",
        latencyMs: 9 + Math.floor(random() * 20),
        tokenUsage: {} as Prisma.InputJsonValue,
        createdAt: receivedAt,
      },
    });

    if (noise.unwanted && email.id) {
      const action = noise.category === "SPAM" ? "DELETE" : "ARCHIVE";
      await prisma.cleanupAction.create({
        data: {
          userId: user.id,
          emailId: email.id,
          type: action as never,
          status: "PROPOSED",
          reason: noise.category === "SPAM" ? "Identified as spam by the classifier" : "Recurring newsletter or promotion",
          category: noise.category as never,
          batchId: `demo-batch-${new Date().toISOString().slice(0, 10)}`,
          senderEmail: noise.sender,
          protectedReason: null,
          isDemo: true,
        },
      });

      if (noise.category === "PROMOTIONAL") promotedCount += 1;
      if (noise.category === "SPAM") spamCount += 1;
      if (noise.category === "NEWSLETTER") newsletterCount += 1;
    }
  }

  // One demo email awaiting user review (low confidence path).
  const reviewEmail = await prisma.email.create({
    data: {
      userId: user.id,
      gmailAccountId: gmailAccount.id,
      gmailMessageId: "demo-msg-review-needed",
      fromName: "Recruiting Team",
      fromEmail: "talent@brightstack.io",
      toEmail: "demo.candidate@gmail.com",
      subject: "Quick question about your availability",
      snippet: "Hi, we came across your profile and would like to understand your availability.",
      bodyText:
        "Hi, we came across your profile and would like to understand your availability for a role we are hiring for. Could you share a convenient time to talk? Regards, Recruiting Team",
      receivedAt: daysAgo(1, 15),
      labels: ["INBOX"],
      isImportant: false,
      isUnread: true,
      processingState: "NEEDS_REVIEW",
      attempts: 1,
      needsReview: true,
      createdAt: daysAgo(1, 15),
    },
  });

  await prisma.emailAnalysis.create({
    data: {
      emailId: reviewEmail.id,
      userId: user.id,
      category: "JOB",
      subCategory: "OTHER_JOB",
      priority: "MEDIUM",
      confidence: 0.58,
      requiresAction: true,
      needsReview: true,
      reasoning: "The email mentions hiring and availability but does not name a role, so MailOps is not confident.",
      summary: "A recruiter is asking about your availability but has not named the role.",
      extracted: {
        company: "Brightstack",
        role: null,
        recruiterEmail: "talent@brightstack.io",
        requiredAction: "Reply with your availability",
        confidence: 0.58,
      } as Prisma.InputJsonValue,
      isUnwanted: false,
      model: "heuristic:classifier@1.3.0",
      provider: "heuristic",
      promptVersion: "classifier@1.3.0",
      latencyMs: 18,
      tokenUsage: {} as Prisma.InputJsonValue,
    },
  });

  // --- Notifications + attempts for key events ------------------------------
  const notificationPlan: Array<{
    application: (typeof applicationRecords)[number];
    type: string;
    severity: string;
    title: string;
    body: string;
    requiresAck: boolean;
    acknowledged: boolean;
    escalated: boolean;
    daysAgo: number;
  }> = [];

  for (const application of applicationRecords) {
    if (["SHORTLISTED", "ASSESSMENT", "INTERVIEW", "FINAL_ROUND"].includes(application.status)) {
      notificationPlan.push({
        application,
        type: "RECRUITER_ACTION",
        severity: application.status === "INTERVIEW" || application.status === "FINAL_ROUND" ? "CRITICAL" : "HIGH",
        title: `${application.company} — ${application.role}: ${application.status.toLowerCase().replace(/_/g, " ")}`,
        body: `The recruiter moved your application to the next stage. Open MailOps for the full details.`,
        requiresAck: true,
        acknowledged: false,
        escalated: application.status === "INTERVIEW",
        daysAgo: 2,
      });
    }
    if (application.status === "OFFER") {
      notificationPlan.push({
        application,
        type: "OFFER_RECEIVED",
        severity: "CRITICAL",
        title: `${application.company} — ${application.role}: you have an offer`,
        body: "An offer letter arrived. Review the compensation and respond before the deadline.",
        requiresAck: true,
        acknowledged: false,
        escalated: true,
        daysAgo: 3,
      });
    }
    if (application.status === "REJECTED") {
      notificationPlan.push({
        application,
        type: "REJECTION_RECEIVED",
        severity: "HIGH",
        title: `${application.company} — ${application.role}: application not selected`,
        body: "The application history has been saved.",
        requiresAck: false,
        acknowledged: true,
        escalated: false,
        daysAgo: 8,
      });
    }
  }

  for (const plan of notificationPlan) {
    const createdAt = daysAgo(plan.daysAgo, 10);
    const notification = await prisma.notification.create({
      data: {
        userId: user.id,
        applicationId: plan.application.id,
        type: plan.type as never,
        severity: plan.severity as never,
        title: plan.title,
        body: plan.body,
        actionUrl: `/applications/${plan.application.id}`,
        actionLabel: "Open in MailOps",
        requiresAck: plan.requiresAck,
        acknowledgedAt: plan.acknowledged ? new Date(createdAt.getTime() + 22 * 60_000) : null,
        acknowledgedVia: plan.acknowledged ? "DASHBOARD" : null,
        status: plan.escalated ? "ESCALATED" : plan.acknowledged ? "ACKNOWLEDGED" : "SENT",
        escalationStage: plan.escalated ? 1 : -1,
        nextEscalationAt: plan.escalated ? new Date(createdAt.getTime() + 150 * 60_000) : null,
        dedupeKey: `demo:${plan.type}:${plan.application.id}`,
        isDemo: true,
        metadata: {
          plan: {
            channels: { dashboard: true, slack: true, whatsapp: true, email: false },
            escalation: { enabled: plan.requiresAck, delaysMinutes: [30, 60, 120], maxStage: 2, stages: ["SLACK", "WHATSAPP"] },
            voiceEligible: false,
            voiceEventKey: null,
            voiceSuppressionReason: "Voice escalation is disabled for this account.",
          },
          payload: {
            title: plan.title,
            body: plan.body,
            actionUrl: `http://localhost:3000/applications/${plan.application.id}`,
            actionLabel: "Open in MailOps",
            severity: plan.severity,
            company: plan.application.company,
            role: plan.application.role,
            status: null,
            deadline: null,
          },
        } as Prisma.InputJsonValue,
        createdAt,
      },
    });

    await prisma.notificationAttempt.create({
      data: {
        notificationId: notification.id,
        channel: "DASHBOARD",
        status: "SENT",
        stage: -1,
        provider: "mailops-dashboard",
        attemptNo: 1,
        sentAt: createdAt,
        createdAt,
      },
    });

    if (plan.escalated) {
      const slackAt = new Date(createdAt.getTime() + 30 * 60_000);
      const whatsappAt = new Date(createdAt.getTime() + 90 * 60_000);
      await prisma.notificationAttempt.createMany({
        data: [
          {
            notificationId: notification.id,
            channel: "SLACK",
            status: "SENT",
            stage: 0,
            provider: "slack-webhook",
            attemptNo: 1,
            sentAt: slackAt,
            createdAt: slackAt,
          },
          {
            notificationId: notification.id,
            channel: "WHATSAPP",
            status: "SENT",
            stage: 1,
            provider: "cloud-api",
            attemptNo: 1,
            sentAt: whatsappAt,
            createdAt: whatsappAt,
          },
        ],
      });
    }
  }

  // --- Scan jobs ------------------------------------------------------------
  for (let index = 0; index < 8; index += 1) {
    const startedAt = daysAgo(index, 6 + index);
    const durationMs = 4_000 + Math.floor(random() * 20_000);
    await prisma.scanJob.create({
      data: {
        userId: user.id,
        gmailAccountId: gmailAccount.id,
        type: index === 7 ? "INITIAL" : "SCHEDULED",
        status: "COMPLETED",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + durationMs),
        durationMs,
        messagesScanned: 40 + Math.floor(random() * 120),
        messagesNew: index === 7 ? 42 : Math.floor(random() * 18),
        messagesQueued: Math.floor(random() * 18),
        messagesSkipped: 20 + Math.floor(random() * 60),
        cursor: `demo-history-${20260921 - index}`,
        isDemo: true,
        triggeredBy: "scheduler",
        createdAt: startedAt,
      },
    });
  }

  // --- Audit trail ----------------------------------------------------------
  const auditEntries = [
    { actor: "AI", action: "email.classified", summary: "Classified 42 emails after the initial scan" },
    { actor: "AI", action: "application.created", summary: "Created applications from recruitment emails" },
    { actor: "AI", action: "application.status_changed", summary: "Microsoft — Software Engineer: Shortlisted → Interview" },
    { actor: "SYSTEM", action: "notification.channel_sent", summary: "Delivered via Slack" },
    { actor: "SYSTEM", action: "notification.escalated", summary: "Escalated to WhatsApp after 30 minutes without acknowledgement" },
    { actor: "AI", action: "cleanup.proposed", summary: "Proposed 11 promotional emails for cleanup" },
    { actor: "SYSTEM", action: "notification.voice_call_suppressed", summary: "Voice escalation is disabled for this account." },
    { actor: "USER", action: "settings.updated", summary: "Enabled Slack and WhatsApp escalation channels" },
  ];

  for (let index = 0; index < auditEntries.length; index += 1) {
    const entry = auditEntries[index];
    const createdAt = daysAgo(Math.floor(index / 2), 9 + index);
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        actor: entry.actor as never,
        action: entry.action,
        entityType: entry.action.split(".")[0],
        entityId: null,
        summary: entry.summary,
        metadata: { seeded: true } as Prisma.InputJsonValue,
        createdAt,
      },
    });
  }

  const counts = {
    applications: await prisma.application.count({ where: { userId: user.id } }),
    emails: await prisma.email.count({ where: { userId: user.id } }),
    analyses: await prisma.emailAnalysis.count({ where: { userId: user.id } }),
    events: await prisma.applicationEvent.count({ where: { userId: user.id } }),
    notifications: await prisma.notification.count({ where: { userId: user.id } }),
    cleanupProposals: await prisma.cleanupAction.count({ where: { userId: user.id, status: "PROPOSED" } }),
    auditLogs: await prisma.auditLog.count({ where: { userId: user.id } }),
    scanJobs: await prisma.scanJob.count({ where: { userId: user.id } }),
  };

  console.log("\n✓ Seed complete. All rows are flagged isDemo = true.");
  console.log(`  Demo login:  ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Applications:       ${counts.applications}`);
  console.log(`  Emails:             ${counts.emails}`);
  console.log(`  AI analyses:        ${counts.analyses}`);
  console.log(`  Timeline events:    ${counts.events}`);
  console.log(`  Notifications:      ${counts.notifications}`);
  console.log(`  Cleanup proposals:  ${counts.cleanupProposals} (promo ${promotedCount}, spam ${spamCount}, newsletter ${newsletterCount})`);
  console.log(`  Audit log entries:  ${counts.auditLogs}`);
  console.log(`  Scan jobs:          ${counts.scanJobs}`);
  console.log("\n  Connect a real Gmail account from Settings to replace the demo data with live scanning.\n");
}

/** Maps an application status to the email that would have produced it. */
function emailForStatus(status: string): {
  subCategory: string;
  priority: string;
  subject: string;
  summary: string;
  body: string;
  reasoning: string;
  requiresAction: boolean;
  daysAgo: number;
  deadlineDaysAgo?: number;
  requiredAction: string | null;
} | null {
  switch (status) {
    case "APPLIED":
      return {
        subCategory: "APPLICATION_RECEIVED",
        priority: "MEDIUM",
        subject: "We have received your application for {role}",
        summary: "{company} confirmed receipt of your application for {role}.",
        body: "Thank you for applying to {company}. We have received your application for the {role} position and will be in touch.",
        reasoning: "Detected because the email confirms receipt of an application.",
        requiresAction: false,
        daysAgo: 1,
        requiredAction: null,
      };
    case "ACKNOWLEDGED":
      return {
        subCategory: "APPLICATION_ACKNOWLEDGED",
        priority: "MEDIUM",
        subject: "Your {company} application is under review",
        summary: "{company} is reviewing your application for {role}.",
        body: "Thank you for your interest in {company}. Our team is currently reviewing your application for the {role} role.",
        reasoning: "Detected because the email states the application is under review.",
        requiresAction: false,
        daysAgo: 5,
        requiredAction: null,
      };
    case "SHORTLISTED":
      return {
        subCategory: "SHORTLISTED",
        priority: "HIGH",
        subject: "Congratulations! You have been shortlisted for {role}",
        summary: "{company} shortlisted your application for {role}.",
        body: "Congratulations. We are pleased to inform you that your profile has been shortlisted for the {role} position at {company}.",
        reasoning: "Detected because the email uses shortlisting language and congratulates the candidate.",
        requiresAction: false,
        daysAgo: 3,
        requiredAction: null,
      };
    case "ASSESSMENT":
      return {
        subCategory: "ASSESSMENT",
        priority: "HIGH",
        subject: "Online assessment for your {role} application",
        summary: "{company} sent an online assessment for {role}.",
        body: "Please complete the online assessment for the {role} position at {company}. The assessment must be completed within 5 days.",
        reasoning: "Detected because the email contains an assessment request with a deadline.",
        requiresAction: true,
        daysAgo: 4,
        deadlineDaysAgo: -3,
        requiredAction: "Complete the online assessment",
      };
    case "INTERVIEW":
      return {
        subCategory: "INTERVIEW",
        priority: "CRITICAL",
        subject: "Interview invitation — {role} at {company}",
        summary: "{company} invited you to interview for {role}.",
        body: "We would like to invite you to a technical interview for the {role} position at {company}. Please confirm a slot before the deadline.",
        reasoning: "Detected because the email contains an interview invitation and a scheduling request.",
        requiresAction: true,
        daysAgo: 2,
        deadlineDaysAgo: -4,
        requiredAction: "Confirm your interview slot",
      };
    case "FINAL_ROUND":
      return {
        subCategory: "FINAL_ROUND",
        priority: "CRITICAL",
        subject: "Final round interview — {role} at {company}",
        summary: "{company} invited you to the final round for {role}.",
        body: "You have progressed to the final round for the {role} position at {company}. Please confirm your availability within 2 days.",
        reasoning: "Detected because the email references a final round and asks for confirmation.",
        requiresAction: true,
        daysAgo: 2,
        deadlineDaysAgo: -1,
        requiredAction: "Confirm availability for the final round",
      };
    case "OFFER":
      return {
        subCategory: "OFFER",
        priority: "CRITICAL",
        subject: "Your offer letter from {company}",
        summary: "{company} extended an offer for {role}.",
        body: "We are pleased to offer you the {role} position at {company}. Please review and respond to the offer letter within 7 days.",
        reasoning: "Detected because the email contains an offer of employment and a response deadline.",
        requiresAction: true,
        daysAgo: 3,
        deadlineDaysAgo: -6,
        requiredAction: "Review and respond to the offer",
      };
    case "REJECTED":
      return {
        subCategory: "REJECTION",
        priority: "MEDIUM",
        subject: "Update on your {role} application",
        summary: "{company} did not move forward with your {role} application.",
        body: "We regret to inform you that we will not be moving forward with your application for the {role} position at {company}. We wish you the best.",
        reasoning: "Detected because the email states the process will not continue.",
        requiresAction: false,
        daysAgo: 8,
        requiredAction: null,
      };
    case "ON_HOLD":
      return {
        subCategory: "OTHER_JOB",
        priority: "LOW",
        subject: "Update regarding your {role} application",
        summary: "{company} paused the {role} hiring process.",
        body: "We would like to let you know that the {role} position at {company} is temporarily on hold. We will update you once it reopens.",
        reasoning: "Detected because the email references the hiring process without a stage change.",
        requiresAction: false,
        daysAgo: 9,
        requiredAction: null,
      };
    default:
      return null;
  }
}

function statusFromEventType(type: string): ApplicationStatus | null {
  switch (type) {
    case "APPLICATION_CREATED":
      return "APPLIED";
    case "INTERVIEW_SCHEDULED":
      return "INTERVIEW";
    case "ASSESSMENT_ASSIGNED":
      return "ASSESSMENT";
    case "OFFER_ISSUED":
      return "OFFER";
    case "REJECTION_RECEIVED":
      return "REJECTED";
    case "WITHDRAWN":
      return "WITHDRAWN";
    default:
      return null;
  }
}

function statusFromSubCategory(subCategory: string): string | null {
  const map: Record<string, string> = {
    APPLICATION_RECEIVED: "APPLIED",
    APPLICATION_ACKNOWLEDGED: "ACKNOWLEDGED",
    SHORTLISTED: "SHORTLISTED",
    ASSESSMENT: "ASSESSMENT",
    INTERVIEW: "INTERVIEW",
    FINAL_ROUND: "FINAL_ROUND",
    OFFER: "OFFER",
    REJECTION: "REJECTED",
    WITHDRAWN: "WITHDRAWN",
  };
  return map[subCategory] ?? null;
}

void COMPANIES;
void ROLES;
void LOCATIONS;

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
