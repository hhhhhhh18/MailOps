"use client";

import { useState } from "react";
import { NotificationsView } from "@/components/domain/notification-card";
import { Card, InlineAlert } from "@/components/ui/primitives";
import { PageHeader } from "@/components/ui/data";
import { useSettings } from "@/lib/hooks";
import { CHANNEL_LABELS } from "@/lib/utils";

/** Notifications + escalation controls (spec #14, #15). */
export default function NotificationsPage() {
  const [page, setPage] = useState(1);
  const { data: settings } = useSettings();

  const enabledChannels = settings
    ? [
        settings.settings.notifyDashboard && "DASHBOARD",
        settings.settings.notifySlack && "SLACK",
        settings.settings.notifyWhatsapp && "WHATSAPP",
        settings.settings.notifyEmail && "EMAIL",
        settings.settings.notifyVoice && "VOICE",
      ].filter(Boolean)
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notifications"
        description="Important recruitment updates, and the escalation ladder behind each one."
      />

      {settings && (
        <Card title="How MailOps reaches you" description="Configured in Settings → Notifications">
          <div className="space-y-2 text-xs text-secondary">
            <p>
              Enabled channels:{" "}
              {enabledChannels.length
                ? enabledChannels.map((channel) => CHANNEL_LABELS[channel as string] ?? channel).join(" → ")
                : "dashboard only"}
            </p>
            <p className="text-muted">
              Escalation delays: {settings.settings.escalationDelaysMinutes.map((minutes, index) => `stage ${index + 1} +${minutes}m`).join(", ")}
            </p>
            <p className="text-muted">
              Voice calls are {settings.settings.voiceEnabled ? "enabled" : "disabled"}
              {settings.settings.voiceEnabled
                ? ` · max ${settings.settings.voiceMaxCallsPerDay}/day · quiet hours ${settings.settings.voiceQuietHoursStart}:00–${settings.settings.voiceQuietHoursEnd}:00`
                : " (opt-in)"}
            </p>
          </div>
        </Card>
      )}

      {settings && !settings.settings.escalationEnabled && (
        <InlineAlert tone="waiting" title="Escalation is switched off">
          MailOps will only show notifications in the dashboard. Enable escalation in Settings to also reach Slack or WhatsApp.
        </InlineAlert>
      )}

      <NotificationsView page={page} onPageChange={setPage} />
    </div>
  );
}
