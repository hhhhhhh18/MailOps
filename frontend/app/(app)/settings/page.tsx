"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  KeyRound,
  Link2,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Badge, Button, Card, EmptyState, InlineAlert, Input, Select, Skeleton, Stat, Switch } from "@/components/ui/primitives";
import { PageHeader } from "@/components/ui/data";
import { ConfirmDialog, useToast } from "@/components/ui/feedback";
import {
  useChangePassword,
  useConnectGmail,
  useMe,
  useDeleteEmailData,
  useDiagnostics,
  useDisconnectGmail,
  useDisconnectIntegration,
  useGmailAccounts,
  usePrivacySummary,
  useSettings,
  useTriggerScan,
  useUpdateSettings,
  useUpsertIntegration,
} from "@/lib/hooks";
import { VerificationBanner, VerificationStatus } from "@/components/domain/verification";
import { API_URL, ApiError } from "@/lib/api";
import {
  PASSWORD_MIN_LENGTH,
  describePasswordProblem,
  formatDate,
  formatDuration,
  formatRelative,
  pluralize,
} from "@/lib/utils";
import type { IntegrationStatus, UserSettings } from "@/lib/types";

/**
 * Settings (spec #26, #28, #34).
 *
 * Every section is a plain form over the settings API. The two areas that carry
 * real weight are Voice (opt-in, with quiet hours and a call cap) and Privacy
 * (what MailOps stores, and how to get rid of it), so both are given explicit,
 * non-euphemistic copy.
 */

const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "gmail", label: "Gmail" },
  { id: "notifications", label: "Notifications" },
  { id: "escalation", label: "Escalation" },
  { id: "voice", label: "Voice" },
  { id: "scanning", label: "Scan frequency" },
  { id: "cleanup", label: "Cleanup preferences" },
  { id: "privacy", label: "Privacy & data" },
  { id: "security", label: "Security" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * `useSearchParams` must be inside a Suspense boundary so the route can be
 * prerendered. The section rail reads ?section= to deep-link from other pages.
 */
export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      <SettingsContent />
    </Suspense>
  );
}

function SettingsContent() {
  const searchParams = useSearchParams();
  const toast = useToast();

  const [section, setSection] = useState<SectionId>((searchParams.get("section") as SectionId) ?? "account");

  const { data, isLoading, isError, refetch } = useSettings();
  const updateSettings = useUpdateSettings();

  const gmailResult = searchParams.get("gmail");

  useEffect(() => {
    if (!gmailResult) return;
    if (gmailResult === "connected") toast.success("Gmail connected", "MailOps has started its first scan of your inbox.");
    else if (gmailResult === "denied") toast.error("Connection cancelled", "You declined the Google permission request.");
    else toast.error("Gmail connection failed", "Please try again, and check the server configuration if it keeps failing.");
    // Only announce once per navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gmailResult]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <EmptyState
          title="Could not load settings"
          description="Your configuration is safe — this is a display problem."
          action={
            <Button size="sm" variant="secondary" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      </Card>
    );
  }

  const { settings, capabilities } = data;

  const patch = (change: Partial<UserSettings> & { name?: string; timezone?: string }, message?: string) =>
    updateSettings.mutate(change, {
      onSuccess: () => message && toast.success(message),
      onError: (error) =>
        toast.error("Could not save", error instanceof Error ? error.message : "Please try again."),
    });

  return (
    <div className="space-y-4">
      <PageHeader title="Settings" description="Everything MailOps does is controlled from here." />

      {/* Section navigation: a list on mobile, a rail on desktop. */}
      <div className="flex gap-4">
        <nav className="hidden w-48 shrink-0 lg:block">
          <ul className="space-y-0.5">
            {SECTIONS.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => setSection(entry.id)}
                  className={
                    section === entry.id
                      ? "w-full rounded-lg bg-[color:var(--tone-accent-bg)] px-3 py-2 text-left text-sm font-medium text-[color:var(--tone-accent)]"
                      : "w-full rounded-lg px-3 py-2 text-left text-sm text-secondary hover:bg-[color:var(--surface-hover)]"
                  }
                >
                  {entry.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 space-y-4">
          <div className="lg:hidden">
            <Select value={section} onChange={(event) => setSection(event.target.value as SectionId)} label="Section">
              {SECTIONS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </div>

          {/* ------------------------------------------------------------------ */}
          {/* Account                                                            */}
          {/* ------------------------------------------------------------------ */}
          {section === "account" && (
            <>
              <Card title="Account" description="Your MailOps identity, separate from the Gmail account you connect">
                <div className="space-y-3">
                  <Input
                    label="Name"
                    defaultValue={data.account.name ?? ""}
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      if (value && value !== data.account.name) patch({ name: value }, "Name updated");
                    }}
                  />
                  <Input label="Email" defaultValue={data.account.email} disabled hint="Your sign-in address cannot be changed here." />
                  <Input
                    label="Timezone"
                    defaultValue={data.account.timezone}
                    onBlur={(event) => patch({ timezone: event.target.value }, "Timezone updated")}
                    hint="Used for quiet hours and the 'good morning' greeting."
                  />
                </div>
              </Card>

              <Card title="Diagnostics" description="What MailOps is running with">
                <DiagnosticsPanel />
              </Card>
            </>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Gmail                                                              */}
          {/* ------------------------------------------------------------------ */}
          {section === "gmail" && (
            <>
              {!capabilities.gmailConfigured && (
                <InlineAlert tone="waiting" title="Gmail is not configured on this server">
                  An administrator must set <span className="font-mono">GOOGLE_CLIENT_ID</span> and{" "}
                  <span className="font-mono">GOOGLE_CLIENT_SECRET</span> in the backend environment before accounts can be
                  connected.
                </InlineAlert>
              )}
              <GmailSection />
            </>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Notifications                                                      */}
          {/* ------------------------------------------------------------------ */}
          {section === "notifications" && (
            <>
              <Card title="Where MailOps can reach you" description="Level 1 is always available; the others are optional">
                <div className="divide-y divide-[color:var(--surface-border)]">
                  <Switch
                    label="MailOps dashboard"
                    description="Every important event appears in the app. Recommended."
                    checked={settings.notifyDashboard}
                    onChange={(next) => patch({ notifyDashboard: next })}
                  />
                  <Switch
                    label="Slack"
                    description={
                      capabilities.slackConfigured
                        ? "Send important recruitment updates to your Slack channel."
                        : "No Slack webhook configured on this server yet."
                    }
                    checked={settings.notifySlack}
                    disabled={!capabilities.slackConfigured && !settings.notifySlack}
                    onChange={(next) => patch({ notifySlack: next })}
                  />
                  <Switch
                    label="WhatsApp"
                    description={
                      capabilities.whatsappConfigured
                        ? "Escalate to WhatsApp when a notification goes unacknowledged."
                        : "No WhatsApp Business credentials configured on this server yet."
                    }
                    checked={settings.notifyWhatsapp}
                    disabled={!capabilities.whatsappConfigured && !settings.notifyWhatsapp}
                    onChange={(next) => patch({ notifyWhatsapp: next })}
                  />
                  <Switch
                    label="Email"
                    description="Receive a copy of important notifications by email."
                    checked={settings.notifyEmail}
                    onChange={(next) => patch({ notifyEmail: next })}
                  />
                  <Switch
                    label="AI voice call"
                    description="Off by default. When enabled, only the critical event types you choose below can trigger a call."
                    checked={settings.notifyVoice}
                    danger
                    onChange={(next) => patch({ notifyVoice: next, ...(next ? {} : { voiceEnabled: false }) })}
                  />
                </div>

                <div className="mt-4 border-t border-[color:var(--surface-border)] pt-4">
                  <Select
                    label="Only notify me at or above"
                    value={settings.notifyMinSeverity}
                    onChange={(event) => patch({ notifyMinSeverity: event.target.value as UserSettings["notifyMinSeverity"] })}
                    hint="LOW is everything tracked. HIGH keeps only shortlists, interviews, offers and recruiter requests."
                  >
                    <option value="LOW">Everything (low and above)</option>
                    <option value="MEDIUM">Notable (medium and above)</option>
                    <option value="HIGH">Important (high and above)</option>
                    <option value="CRITICAL">Critical only (offers, urgent deadlines)</option>
                  </Select>
                </div>
              </Card>

              <IntegrationCard
                kind="SLACK"
                title="Slack integration"
                description="Paste an incoming-webhook URL. MailOps posts only application facts — never email contents."
                icon={<Send className="h-4 w-4" />}
                secretFields={[{ key: "webhookUrl", label: "Slack webhook URL", placeholder: "https://hooks.slack.com/services/…" }]}
              />

              <IntegrationCard
                kind="WHATSAPP"
                title="WhatsApp integration"
                description="Uses a compliant WhatsApp Business / Cloud API provider. Business-initiated messages require an approved template named MAILOPS_ALERT."
                icon={<MessageSquare className="h-4 w-4" />}
                configFields={[
                  { key: "phoneNumberId", label: "Phone number ID" },
                  { key: "to", label: "Your WhatsApp number", placeholder: "+91…" },
                ]}
                secretFields={[{ key: "accessToken", label: "Access token" }]}
              />
            </>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Escalation                                                         */}
          {/* ------------------------------------------------------------------ */}
          {section === "escalation" && (
            <Card
              title="Notification escalation"
              description="How long MailOps waits before trying the next channel"
            >
              <div className="space-y-4">
                <Switch
                  label="Enable escalation"
                  description="When off, notifications stay in the dashboard and never escalate."
                  checked={settings.escalationEnabled}
                  onChange={(next) => patch({ escalationEnabled: next })}
                />

                <div>
                  <p className="text-xs font-medium text-secondary">Delays before each stage</p>
                  <p className="mt-0.5 text-2xs text-muted">
                    Stage 1 is Slack, stage 2 is WhatsApp, stage 3 is a voice call. If you acknowledge at any point, the ladder
                    stops immediately.
                  </p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    {[0, 1, 2].map((index) => (
                      <Input
                        key={index}
                        label={`Stage ${index + 1} (minutes)`}
                        type="number"
                        min={1}
                        max={1440}
                        defaultValue={settings.escalationDelaysMinutes[index] ?? 30}
                        onBlur={(event) => {
                          const next = [...settings.escalationDelaysMinutes];
                          next[index] = Math.max(1, Number(event.target.value) || 30);
                          patch({ escalationDelaysMinutes: next });
                        }}
                      />
                    ))}
                  </div>
                </div>

                <Select
                  label="Maximum escalation stage"
                  value={String(settings.escalationMaxStage)}
                  onChange={(event) => patch({ escalationMaxStage: Number(event.target.value) })}
                  hint="Capping this at 1 means MailOps will never escalate beyond Slack."
                >
                  <option value="0">Stage 1 only (Slack)</option>
                  <option value="1">Up to stage 2 (WhatsApp)</option>
                  <option value="2">Up to stage 3 (voice call)</option>
                </Select>
              </div>
            </Card>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Voice                                                              */}
          {/* ------------------------------------------------------------------ */}
          {section === "voice" && (
            <Card title="AI voice escalation" description="Off by default. Calls are the last resort, never the first contact.">
              <div className="space-y-4">
                <InlineAlert tone="waiting" title="Calls must be explicitly enabled">
                  MailOps will only place a call when you enable voice here, choose the event types below, and a notification has
                  already gone unacknowledged through the earlier channels.
                </InlineAlert>

                <Switch
                  label="Enable voice calls"
                  description="Allows MailOps to place an automated call for critical recruitment events."
                  checked={settings.voiceEnabled}
                  danger
                  onChange={(next) => patch({ voiceEnabled: next, notifyVoice: next }, next ? "Voice calls enabled" : "Voice calls disabled")}
                />

                <div className="grid gap-3 sm:grid-cols-3">
                  <Input
                    label="Maximum calls per day"
                    type="number"
                    min={0}
                    max={10}
                    defaultValue={settings.voiceMaxCallsPerDay}
                    disabled={!settings.voiceEnabled}
                    onBlur={(event) => patch({ voiceMaxCallsPerDay: Math.max(0, Number(event.target.value) || 0) })}
                  />
                  <Input
                    label="Quiet hours start"
                    type="number"
                    min={0}
                    max={23}
                    defaultValue={settings.voiceQuietHoursStart}
                    disabled={!settings.voiceEnabled}
                    hint="24-hour clock, local to your timezone."
                    onBlur={(event) => patch({ voiceQuietHoursStart: Number(event.target.value) })}
                  />
                  <Input
                    label="Quiet hours end"
                    type="number"
                    min={0}
                    max={23}
                    defaultValue={settings.voiceQuietHoursEnd}
                    disabled={!settings.voiceEnabled}
                    onBlur={(event) => patch({ voiceQuietHoursEnd: Number(event.target.value) })}
                  />
                </div>

                <div className="border-t border-[color:var(--surface-border)] pt-4">
                  <p className="text-xs font-medium text-secondary">Critical events that may trigger a call</p>
                  <div className="mt-1 divide-y divide-[color:var(--surface-border)]">
                    {[
                      { key: "OFFER", label: "Offer received" },
                      { key: "INTERVIEW", label: "Interview invitation" },
                      { key: "ASSESSMENT", label: "Assessment deadline" },
                      { key: "RECRUITER_ACTION", label: "Urgent recruiter request" },
                      { key: "DEADLINE_APPROACHING", label: "Deadline within 3 days" },
                    ].map((event) => (
                      <Switch
                        key={event.key}
                        label={event.label}
                        checked={settings.voiceCriticalEvents.includes(event.key)}
                        disabled={!settings.voiceEnabled}
                        onChange={(next) => {
                          const set = new Set(settings.voiceCriticalEvents);
                          if (next) set.add(event.key);
                          else set.delete(event.key);
                          patch({ voiceCriticalEvents: Array.from(set) });
                        }}
                      />
                    ))}
                  </div>
                  <p className="mt-3 text-2xs text-muted">
                    Rejections, job alerts and promotional mail can never trigger a call, regardless of these settings.
                  </p>
                </div>

                <InlineAlert tone="info" title="What the call says">
                  The voice agent identifies itself as an automated MailOps assistant, summarises the update in one or two
                  sentences, states any deadline, and directs you to the dashboard. It never reads your email aloud.
                </InlineAlert>
              </div>
            </Card>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Scanning                                                           */}
          {/* ------------------------------------------------------------------ */}
          {section === "scanning" && (
            <Card title="Scan frequency" description="How often MailOps reads your inbox for new mail">
              <div className="space-y-4">
                <Switch
                  label="Automatic scanning"
                  description="Turn this off to stop MailOps reading your inbox entirely. Nothing already stored is removed."
                  checked={settings.scanningEnabled}
                  onChange={(next) => patch({ scanningEnabled: next })}
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Scan interval (hours)"
                    type="number"
                    min={0.25}
                    max={24}
                    step={0.25}
                    defaultValue={Math.round((settings.scanIntervalMinutes / 60) * 100) / 100}
                    disabled={!settings.scanningEnabled}
                    onBlur={(event) => {
                      const hours = Math.min(24, Math.max(0.25, Number(event.target.value) || 3.5));
                      patch({ scanIntervalMinutes: Math.round(hours * 60) });
                    }}
                    hint="Default is every 3.5 hours. Scans run in the background, never during a page load."
                  />
                  <Select
                    label="Preset"
                    value=""
                    disabled={!settings.scanningEnabled}
                    onChange={(event) => {
                      const minutes = Number(event.target.value);
                      if (minutes) patch({ scanIntervalMinutes: minutes }, "Scan frequency updated");
                    }}
                  >
                    <option value="">Choose a preset…</option>
                    <option value="30">Every 30 minutes</option>
                    <option value="60">Hourly</option>
                    <option value="210">Every 3.5 hours (default)</option>
                    <option value="360">Every 6 hours</option>
                    <option value="720">Twice a day</option>
                    <option value="1440">Once a day</option>
                  </Select>
                </div>

                <ScanControls />
              </div>
            </Card>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Cleanup                                                            */}
          {/* ------------------------------------------------------------------ */}
          {section === "cleanup" && (
            <Card title="Cleanup preferences" description="What MailOps is allowed to propose for cleanup">
              <div className="space-y-4">
                <InlineAlert tone="success" title="Protection is enforced on the server">
                  Job, personal, financial and government mail is excluded from cleanup regardless of these settings, and the
                  rule is re-checked immediately before anything is removed from Gmail.
                </InlineAlert>

                <Switch
                  label="Auto-approve cleanup"
                  description="Not recommended. When on, MailOps may clear mail in the categories below without asking. Protected categories still apply."
                  checked={settings.autoCleanupEnabled}
                  danger
                  onChange={(next) => patch({ autoCleanupEnabled: next }, next ? "Auto-cleanup enabled" : "Manual approval required")}
                />

                <div>
                  <p className="text-xs font-medium text-secondary">Categories MailOps may propose</p>
                  <div className="mt-1 divide-y divide-[color:var(--surface-border)]">
                    {["PROMOTIONAL", "SPAM", "NEWSLETTER", "OTHER"].map((category) => (
                      <Switch
                        key={category}
                        label={category.charAt(0) + category.slice(1).toLowerCase()}
                        checked={settings.cleanupCategories.includes(category)}
                        onChange={(next) => {
                          const set = new Set(settings.cleanupCategories);
                          if (next) set.add(category);
                          else set.delete(category);
                          patch({ cleanupCategories: Array.from(set) });
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div className="border-t border-[color:var(--surface-border)] pt-4">
                  <p className="text-xs font-medium text-secondary">Additional protection</p>
                  <div className="divide-y divide-[color:var(--surface-border)]">
                    <Switch
                      label="Protect job and recruiter email"
                      description="Cannot be disabled in practice — recruitment mail is always excluded."
                      checked={settings.protectJobEmails}
                      disabled
                      onChange={() => undefined}
                    />
                    <Switch
                      label="Protect personal correspondence"
                      checked={settings.protectPersonal}
                      onChange={(next) => patch({ protectPersonal: next })}
                    />
                    <Switch
                      label="Protect financial email"
                      description="Bank, card and payment providers."
                      checked={settings.protectFinancial}
                      onChange={(next) => patch({ protectFinancial: next })}
                    />
                    <Switch
                      label="Protect government and tax email"
                      checked={settings.protectGovernment}
                      onChange={(next) => patch({ protectGovernment: next })}
                    />
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* ------------------------------------------------------------------ */}
          {/* Privacy                                                            */}
          {/* ------------------------------------------------------------------ */}
          {section === "privacy" && <PrivacySection />}

          {/* ------------------------------------------------------------------ */}
          {/* Security                                                           */}
          {/* ------------------------------------------------------------------ */}
          {section === "security" && <SecuritySection />}
        </div>
      </div>
    </div>
  );
}

/** ------------------------------------------------------------------------ */
/** Gmail                                                                    */
/** ------------------------------------------------------------------------ */

function GmailSection() {
  const toast = useToast();
  const { data, isLoading } = useGmailAccounts();
  const connect = useConnectGmail();
  const disconnect = useDisconnectGmail();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  const accounts = data?.accounts ?? [];

  return (
    <>
      <Card title="Connected Gmail accounts" description="MailOps reads only what it needs to find recruitment email">
        {!accounts.length ? (
          <EmptyState
            icon={<Mail className="h-6 w-6" />}
            title="No Gmail account connected"
            description="Connect an account and MailOps will scan your inbox, understand incoming mail and build your application timeline."
            action={
              <Button
                variant="primary"
                onClick={() => connect.mutate("/settings?section=gmail")}
                loading={connect.isPending}
                disabled={!data?.gmailConfigured}
              >
                Connect Gmail
              </Button>
            }
          />
        ) : (
          <ul className="space-y-3">
            {accounts.map((account) => (
              <li key={account.id} className="surface-muted flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {account.emailAddress}
                    <Badge tone={account.status === "CONNECTED" ? "success" : account.status === "EXPIRED" ? "critical" : "neutral"}>
                      {account.status.toLowerCase()}
                    </Badge>
                  </p>
                  <p className="mt-0.5 text-2xs text-muted">
                    Last synced {account.lastSyncAt ? formatRelative(account.lastSyncAt) : "never"} ·{" "}
                    {pluralize(account.grantedScopes.length, "scope")} granted
                  </p>
                  {account.scopeAudit && !account.scopeAudit.ok && (
                    <p className="mt-1 text-2xs text-[color:var(--tone-critical)]">
                      Missing required permission(s): reconnect to grant them.
                    </p>
                  )}
                  {account.lastError && <p className="mt-1 text-2xs text-[color:var(--tone-critical)]">{account.lastError}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {account.status !== "CONNECTED" && (
                    <Button size="sm" variant="primary" onClick={() => connect.mutate("/settings?section=gmail")} loading={connect.isPending}>
                      Reconnect
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setConfirmId(account.id)}>
                    Disconnect
                  </Button>
                </div>
              </li>
            ))}

            <li>
              <Button variant="secondary" size="sm" onClick={() => connect.mutate("/settings?section=gmail")} loading={connect.isPending} icon={<Link2 className="h-3.5 w-3.5" />}>
                Connect another account
              </Button>
            </li>
          </ul>
        )}
      </Card>

      <Card title="What MailOps can access" description="The exact Google permissions requested, and why">
        <ul className="space-y-3">
          {(data?.scopes ?? []).map((scope) => (
            <li key={scope.scope} className="flex gap-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--tone-success)]" />
              <div>
                <p className="text-sm font-medium">{scope.title}</p>
                <p className="mt-0.5 text-xs text-muted">{scope.why}</p>
                <p className="mt-1 font-mono text-2xs text-muted">{scope.scope}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t border-[color:var(--surface-border)] pt-3 text-xs text-muted">
          MailOps does <span className="font-medium text-secondary">not</span> request full mailbox access (
          <span className="font-mono">mail.google.com</span>), permission to send mail on your behalf (
          <span className="font-mono">gmail.send</span>), or access to Drive, Contacts or Calendar.
        </p>
      </Card>

      <ConfirmDialog
        open={confirmId !== null}
        onClose={() => setConfirmId(null)}
        onConfirm={() => {
          if (!confirmId) return;
          disconnect.mutate(confirmId, {
            onSuccess: (result) => {
              setConfirmId(null);
              toast.success(
                "Gmail disconnected",
                result.revoked
                  ? "MailOps' access was revoked in your Google account. Your emails were not touched."
                  : "Stored tokens were deleted. You can also remove MailOps from your Google account permissions page.",
              );
            },
          });
        }}
        loading={disconnect.isPending}
        title="Disconnect this Gmail account?"
        confirmLabel="Disconnect"
        description={
          <div className="space-y-2">
            <p>MailOps will stop scanning and delete the stored OAuth tokens.</p>
            <p className="text-muted">
              Your emails stay exactly where they are. Application history is kept unless you separately delete MailOps data.
            </p>
          </div>
        }
      />
    </>
  );
}

function ScanControls() {
  const toast = useToast();
  const { data } = useGmailAccounts();
  const trigger = useTriggerScan();
  const [fullRescan, setFullRescan] = useState(false);

  const account = data?.accounts.find((entry) => entry.status === "CONNECTED") ?? data?.accounts[0];

  return (
    <div className="border-t border-[color:var(--surface-border)] pt-4">
      <p className="text-xs font-medium text-secondary">Manual scan</p>
      <p className="mt-0.5 text-2xs text-muted">
        Runs in the background worker immediately. A full rescan ignores the stored cursor and re-reads the lookback window.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          disabled={!account}
          loading={trigger.isPending}
          onClick={() =>
            trigger.mutate(
              { gmailAccountId: account?.id, fullRescan },
              { onSuccess: () => toast.success("Scan queued", "MailOps is reading your inbox now.") },
            )
          }
          icon={<RefreshCw className="h-3.5 w-3.5" />}
        >
          Scan now
        </Button>
        <label className="inline-flex items-center gap-2 text-2xs text-muted">
          <input type="checkbox" checked={fullRescan} onChange={(event) => setFullRescan(event.target.checked)} />
          Full rescan
        </label>
      </div>
    </div>
  );
}

/** ------------------------------------------------------------------------ */
/** Integration config                                                        */
/** ------------------------------------------------------------------------ */

function IntegrationCard({
  kind,
  title,
  description,
  icon,
  configFields = [],
  secretFields = [],
}: {
  kind: IntegrationStatus["kind"];
  title: string;
  description: string;
  icon: React.ReactNode;
  configFields?: Array<{ key: string; label: string; placeholder?: string }>;
  secretFields?: Array<{ key: string; label: string; placeholder?: string }>;
}) {
  const toast = useToast();
  const { data } = useSettings();
  const upsert = useUpsertIntegration();
  const remove = useDisconnectIntegration();
  const [values, setValues] = useState<Record<string, string>>({});

  const integration = data?.integrations.find((entry) => entry.kind === kind);

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          {icon}
          {title}
        </span>
      }
      description={description}
      action={
        integration ? (
          <Badge tone={integration.status === "CONNECTED" ? "success" : integration.status === "ERROR" ? "critical" : "neutral"}>
            {integration.status.toLowerCase()}
          </Badge>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {configFields.map((field) => (
          <Input
            key={field.key}
            label={field.label}
            placeholder={field.placeholder}
            defaultValue={String(integration?.config?.[field.key] ?? "")}
            onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
          />
        ))}

        {secretFields.map((field) => (
          <Input
            key={field.key}
            label={field.label}
            type="password"
            placeholder={field.placeholder ?? "Stored encrypted — enter a new value to replace"}
            autoComplete="off"
            onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
            hint="Encrypted with AES-256-GCM before storage. It is never shown again after saving."
          />
        ))}

        {integration?.lastError && <InlineAlert tone="critical" title="Last attempt failed">{integration.lastError}</InlineAlert>}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={upsert.isPending}
            onClick={() => {
              const config = Object.fromEntries(Object.entries(values).filter(([key]) => configFields.some((field) => field.key === key)));
              const secrets = Object.fromEntries(
                Object.entries(values).filter(([key, value]) => secretFields.some((field) => field.key === key) && value),
              );

              upsert.mutate(
                { kind, body: { config, secrets: Object.keys(secrets).length ? secrets : undefined, verify: kind === "SLACK" } },
                {
                  onSuccess: (result) => {
                    setValues({});
                    if (result.status === "ERROR") toast.error("Saved but verification failed", result.lastError ?? undefined);
                    else toast.success("Integration saved");
                  },
                  onError: (error) => toast.error("Could not save", error instanceof Error ? error.message : undefined),
                },
              );
            }}
          >
            Save & verify
          </Button>

          {integration && integration.status !== "DISCONNECTED" && (
            <Button
              size="sm"
              variant="ghost"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(kind, { onSuccess: () => toast.success("Integration disconnected", "Stored credentials were deleted.") })
              }
            >
              Disconnect
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** ------------------------------------------------------------------------ */
/** Privacy                                                                  */
/** ------------------------------------------------------------------------ */

function PrivacySection() {
  const toast = useToast();
  const { data, isLoading } = usePrivacySummary();
  const deleteData = useDeleteEmailData();
  const updateSettings = useUpdateSettings();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [keepHistory, setKeepHistory] = useState(true);

  if (isLoading || !data) return <Skeleton className="h-72 w-full" />;

  return (
    <>
      <Card title="What MailOps stores" description="A complete inventory of your data">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Emails stored" value={data.dataStored.emails} hint={`${data.dataStored.emailBodiesStored} with body text`} />
          <Stat label="AI analyses" value={data.dataStored.analyses} />
          <Stat label="Applications" value={data.dataStored.applications} hint={`${data.dataStored.applicationEvents} timeline events`} />
          <Stat label="Notifications" value={data.dataStored.notifications} />
        </div>

        <dl className="mt-4 space-y-2 text-xs">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Email body storage</dt>
            <dd>{data.retention.storeEmailBody ? "Enabled (minimised text only)" : "Disabled — metadata and snippets only"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Retention window</dt>
            <dd>{data.retention.dataRetentionDays} days</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Oldest stored email</dt>
            <dd>{data.retention.oldestEmailAt ? formatDate(data.retention.oldestEmailAt) : "—"}</dd>
          </div>
        </dl>

        <div className="mt-4 border-t border-[color:var(--surface-border)] pt-4">
          <Switch
            label="Store email bodies"
            description="Off means MailOps keeps only headers and a short snippet — enough to classify and summarise, but not the full message. Turning this off does not delete bodies already stored; the retention sweep will trim them."
            checked={data.retention.storeEmailBody}
            onChange={(next) =>
              updateSettings.mutate({ storeEmailBody: next }, { onSuccess: () => toast.success("Updated") })
            }
          />

          <div className="mt-3 max-w-xs">
            <Input
              label="Data retention (days)"
              type="number"
              min={7}
              max={3650}
              defaultValue={data.retention.dataRetentionDays}
              onBlur={(event) =>
                updateSettings.mutate(
                  { dataRetentionDays: Math.max(7, Number(event.target.value) || 365) },
                  { onSuccess: () => toast.success("Retention updated") },
                )
              }
              hint="Email bodies are trimmed and unlinked emails are purged after this window. Application history is never deleted."
            />
          </div>
        </div>
      </Card>

      <Card title="Your controls" description="Everything you can do about your data, without contacting support">
        <ul className="space-y-3">
          {data.controls.map((control) => (
            <li key={control.id} className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{control.label}</p>
                <p className="mt-0.5 text-xs text-muted">{control.description}</p>
                <p className="mt-1 font-mono text-2xs text-muted">
                  {control.method} {control.endpoint}
                </p>
              </div>
              {control.id === "export-data" && (
                <a
                  href={`${API_URL}/api/settings/privacy/export`}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[color:var(--surface-border)] bg-[color:var(--surface-overlay)] px-3 text-xs hover:bg-[color:var(--surface-hover)]"
                >
                  <Download className="h-3.5 w-3.5" /> Export
                </a>
              )}
              {control.id === "delete-email-data" && (
                <Button size="sm" variant="danger" onClick={() => setConfirmOpen(true)} icon={<Trash2 className="h-3.5 w-3.5" />}>
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="AI processing" description="How your email content is handled">
        <ul className="space-y-2 text-xs text-secondary">
          <li>Email content is sent to the configured AI provider only to classify, extract and summarise it.</li>
          <li>Provider responses are validated against strict schemas before anything is stored — a malformed response never changes your data.</li>
          <li>Internal reasoning is never stored or displayed; only a short user-facing explanation is kept.</li>
          <li>Low-confidence results are never applied automatically; they wait for your confirmation.</li>
        </ul>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() =>
          deleteData.mutate(keepHistory, {
            onSuccess: (result) => {
              setConfirmOpen(false);
              toast.success("Data deleted", result.notes.join(" "));
            },
          })
        }
        loading={deleteData.isPending}
        title="Delete MailOps-stored email data?"
        confirmLabel="Delete email data"
        requirePhrase="DELETE"
        description={
          <div className="space-y-3">
            <p>
              This permanently deletes every email and AI analysis MailOps stored ({data.dataStored.emails} email
              {data.dataStored.emails === 1 ? "" : "s"}). This cannot be undone.
            </p>
            <p className="text-muted">Your actual Gmail messages are not affected — they stay in your mailbox untouched.</p>
            <label className="flex items-start gap-2 rounded-lg bg-[color:var(--surface-overlay)] p-2.5 text-secondary">
              <input type="checkbox" checked={keepHistory} onChange={(event) => setKeepHistory(event.target.checked)} className="mt-0.5" />
              <span>
                Keep my application history and timelines
                <span className="mt-0.5 block text-muted">
                  Recommended. Your application records are the point of MailOps and contain no email content of their own.
                </span>
              </span>
            </label>
          </div>
        }
      />
    </>
  );
}

/** ------------------------------------------------------------------------ */
/** Security                                                                 */
/** ------------------------------------------------------------------------ */

/**
 * Password change.
 *
 * Mirrors the server's policy for immediate feedback, but the server remains the
 * enforcement point. Other devices are signed out by the API; this session is kept
 * alive, and the success message says so rather than leaving it ambiguous.
 */
function PasswordChangeForm() {
  const toast = useToast();
  const changePassword = useChangePassword();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const policyProblem = newPassword ? describePasswordProblem(newPassword) : null;
  const mismatch = confirm.length > 0 && confirm !== newPassword;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (policyProblem) {
      setError(policyProblem);
      return;
    }
    if (newPassword !== confirm) {
      setError("Both passwords must match");
      return;
    }

    try {
      const result = await changePassword.mutateAsync({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirm("");
      toast.success(
        result.revokedSessions > 0
          ? `Password updated. ${pluralize(result.revokedSessions, "other session")} signed out.`
          : "Password updated.",
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not change your password. Please try again.",
      );
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {error && (
        <InlineAlert tone="critical" title="Could not change your password">
          {error}
        </InlineAlert>
      )}

      <label className="block">
        <span className="text-xs font-medium text-secondary">Current password</span>
        <Input
          type="password"
          name="current-password"
          autoComplete="current-password"
          required
          className="mt-1.5"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-secondary">New password</span>
        <Input
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          className="mt-1.5"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
        <span className="mt-1 block text-2xs text-muted">
          At least {PASSWORD_MIN_LENGTH} characters, including a letter and a number.
        </span>
      </label>

      <label className="block">
        <span className="text-xs font-medium text-secondary">Confirm new password</span>
        <Input
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          required
          className="mt-1.5"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        {mismatch && (
          <span className="mt-1 block text-2xs text-[color:var(--tone-critical)]">Passwords do not match.</span>
        )}
      </label>

      <Button
        type="submit"
        variant="primary"
        size="sm"
        loading={changePassword.isPending}
        disabled={!currentPassword || !newPassword || !confirm || Boolean(policyProblem) || mismatch}
      >
        Update password
      </Button>
    </form>
  );
}

function SecuritySection() {
  const toast = useToast();
  const { data: settings } = useSettings();
  const { data: me } = useMe();

  return (
    <>
      <Card title="Email verification" description="The address MailOps sends account email to">
        {me?.user ? (
          <div className="space-y-3">
            <dl>
              <VerificationStatus
                email={me.user.email}
                verified={me.user.emailVerified}
                verifiedAt={me.user.emailVerifiedAt ? formatDate(me.user.emailVerifiedAt) : null}
                verifiedLabel="Verified"
                unverifiedLabel="Not verified"
              />
            </dl>
            {!me.user.emailVerified && <VerificationBanner email={me.user.email} />}
          </div>
        ) : (
          <Skeleton className="h-12 w-full" />
        )}
      </Card>

      <Card title="Password" description="Change the password used to sign in">
        <PasswordChangeForm />
      </Card>

      <Card title="Session" description="How MailOps keeps you signed in">
        <ul className="space-y-2 text-xs text-secondary">
          <li>Short-lived access tokens are delivered in httpOnly cookies that JavaScript cannot read.</li>
          <li>Refresh tokens are stored only as hashes, are rotated on every use, and can be revoked below.</li>
          <li>State-changing requests require a CSRF token that a cross-site attacker cannot obtain.</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="danger"
            icon={<ShieldAlert className="h-3.5 w-3.5" />}
            onClick={async () => {
              await fetch(`${API_URL}/api/auth/sessions/revoke`, {
                method: "POST",
                credentials: "include",
                headers: { "X-CSRF-Token": readCsrf() },
              });
              toast.success("All sessions revoked", "You will need to sign in again on every device.");
              window.location.href = "/login";
            }}
          >
            Sign out everywhere
          </Button>
        </div>
      </Card>

      <Card title="Logging" description="What MailOps records, and what it refuses to record">
        <Switch
          label="Redact sensitive values in logs"
          description="OAuth tokens, passwords, API secrets and full email bodies are never written to logs. This should stay on."
          checked={settings?.settings.redactSensitiveLogs ?? true}
          onChange={() => toast.info("This is enforced by the server", "Log redaction cannot be disabled for safety.")}
        />
        <ul className="mt-3 space-y-1.5 text-xs text-secondary">
          <li>Credentials are encrypted at rest with AES-256-GCM; the encryption key is never stored alongside the data.</li>
          <li>Tokens are never returned to the browser — only whether one is stored.</li>
          <li>Every automated action is written to the audit log with its actor and confidence.</li>
        </ul>
      </Card>
    </>
  );
}

function readCsrf(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|; )mailops_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function DiagnosticsPanel() {
  const { data, isLoading } = useDiagnostics();

  if (isLoading || !data) return <Skeleton className="h-24 w-full" />;

  return (
    <dl className="space-y-2 text-xs">
      <Row label="Environment" value={data.environment} />
      <Row label="Database" value={data.database.ok ? "reachable" : `unavailable — ${data.database.error ?? "unknown"}`} ok={data.database.ok} />
      <Row label="Redis (queues)" value={data.redis.ok ? "reachable" : `unavailable — ${data.redis.error ?? "unknown"}`} ok={data.redis.ok} />
      <Row label="AI provider" value={data.ai.provider === "heuristic" ? "built-in deterministic engine" : data.ai.provider} ok={data.ai.configured} />
      <Row
        label="Encryption key"
        value={data.encryption.configured ? `configured (${data.encryption.length} bytes, ${data.encryption.fingerprint})` : "development fallback in use"}
        ok={data.encryption.configured}
      />
      {!data.redis.ok && (
        <div className="pt-2">
          <InlineAlert tone="waiting" title="Background processing is degraded">
            Without Redis, scanning, AI processing and escalation timers cannot run. The dashboard remains available.
          </InlineAlert>
        </div>
      )}
    </dl>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-1.5 text-right">
        {ok !== undefined &&
          (ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--tone-success)]" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 text-[color:var(--tone-critical)]" />
          ))}
        <span>{value}</span>
      </dd>
    </div>
  );
}
