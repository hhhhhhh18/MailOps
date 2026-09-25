"use client";

import { useState } from "react";
import { MailCheck, MailWarning, RefreshCw } from "lucide-react";
import { Badge, Button, InlineAlert } from "@/components/ui/primitives";
import { useResendVerification } from "@/lib/hooks";
import { ApiError } from "@/lib/api";

/**
 * Unverified-email prompt.
 *
 * Verification does not gate access (the project signs unverified users in), so
 * this is an advisory state with exactly one action: resend the link. It is
 * rendered by the app shell, which means it follows the user across every
 * authenticated page instead of being buried in Settings.
 */
export function VerificationBanner({ email }: { email: string }) {
  const resend = useResendVerification();
  const [notice, setNotice] = useState<{ tone: "info" | "critical"; text: string } | null>(null);

  async function onResend() {
    setNotice(null);
    try {
      const result = await resend.mutateAsync();
      setNotice(
        result.sent
          ? { tone: "info", text: `A new verification link is on its way to ${email}.` }
          : {
              tone: "critical",
              text: "We could not send that email right now. Your account is fine — please try again shortly.",
            },
      );
    } catch (error) {
      setNotice({
        tone: "critical",
        text: error instanceof ApiError ? error.message : "Could not send the verification email.",
      });
    }
  }

  return (
    <div className="rounded-card border border-[color:var(--surface-border)] bg-[color:var(--surface-raised)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <MailWarning className="h-4 w-4 shrink-0 text-[color:var(--tone-info)]" />
        <p className="min-w-[12rem] flex-1 text-xs text-secondary">
          <span className="font-medium text-[color:var(--content-primary)]">Verify your email address.</span>{" "}
          We sent a link to <span className="font-mono text-[color:var(--content-primary)]">{email}</span>.
          Confirming it secures account recovery and lets MailOps reach you.
        </p>
        <Button size="sm" variant="secondary" loading={resend.isPending} onClick={onResend}>
          <RefreshCw className="h-3 w-3" /> Resend link
        </Button>
      </div>

      {notice && (
        <div className="mt-2">
          <InlineAlert tone={notice.tone}>{notice.text}</InlineAlert>
        </div>
      )}
    </div>
  );
}

/**
 * Settings status line.
 *
 * Same information as the banner, in the compact form Settings uses, including
 * when verification happened — the reason `emailVerifiedAt` is a timestamp.
 */
export function VerificationStatus({
  email,
  verified,
  verifiedAt,
  verifiedLabel,
  unverifiedLabel,
}: {
  email: string;
  verified: boolean;
  verifiedAt: string | null;
  verifiedLabel: string;
  unverifiedLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted">Email verification</dt>
      <dd className="flex items-center gap-2 text-right">
        <span className="font-mono text-2xs text-muted">{email}</span>
        {verified ? (
          <>
            <Badge tone="success">
              <MailCheck className="h-3 w-3" /> {verifiedLabel}
            </Badge>
            {verifiedAt && <span className="text-2xs text-muted">{verifiedAt}</span>}
          </>
        ) : (
          <Badge tone="info">{unverifiedLabel}</Badge>
        )}
      </dd>
    </div>
  );
}
