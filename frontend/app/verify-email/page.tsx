"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, CheckCircle2, MailWarning, TimerOff } from "lucide-react";
import { Button, Card, InlineAlert, Skeleton } from "@/components/ui/primitives";
import { useVerifyEmail } from "@/lib/hooks";
import { ApiError } from "@/lib/api";
import type { EmailVerificationStatus } from "@/lib/types";

/**
 * Email verification result page.
 *
 * Handles the four outcomes the API can report. Note that an *already used* token
 * is treated as success: the link is single-use, so a second visit (a mail client
 * prefetching the URL, the user clicking twice, or opening it on two devices) has
 * still achieved what the user wanted, and showing an error there would be wrong.
 */
function statusFromError(error: unknown): EmailVerificationStatus {
  if (error instanceof ApiError) {
    const details = error.details as { status?: EmailVerificationStatus } | undefined;
    if (details?.status === "EXPIRED" || details?.status === "INVALID") return details.status;
  }
  return "INVALID";
}

function VerifyEmailResult() {
  const params = useSearchParams();
  const token = params.get("token");
  const { data, isLoading, error } = useVerifyEmail(token);

  if (!token) {
    return (
      <Card>
        <InlineAlert tone="critical" title="This link is incomplete">
          The verification link is missing its token. Open the button inside the email MailOps sent
          you, or request a new link from Settings.
        </InlineAlert>
        <BackLinks />
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-xs text-secondary">
          <Skeleton className="h-4 w-4 rounded-full" />
          Confirming your email address…
        </div>
      </Card>
    );
  }

  const status: EmailVerificationStatus = data?.status ?? (error ? statusFromError(error) : "INVALID");

  if (status === "VERIFIED" || status === "ALREADY_VERIFIED") {
    return (
      <Card>
        <div className="space-y-4">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--tone-success)]" />
            <div className="text-xs text-secondary">
              <p className="font-medium text-[color:var(--content-primary)]">
                {status === "VERIFIED" ? "Your email address is verified" : "This address is already verified"}
              </p>
              <p className="mt-1">
                {status === "VERIFIED"
                  ? "Thanks — your account is fully set up. MailOps can now reach you about recruitment updates."
                  : "No action is needed. The link you opened had already been used, and verification is already complete."}
              </p>
            </div>
          </div>
          <Link href="/dashboard" className="block">
            <Button variant="primary" className="w-full">
              Continue to MailOps <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </Card>
    );
  }

  if (status === "EXPIRED") {
    return (
      <Card>
        <InlineAlert tone="critical" title="This verification link has expired">
          Verification links are time-limited. Sign in and use “Resend verification email” — we will
          send a fresh link to the same address.
        </InlineAlert>
        <BackLinks />
      </Card>
    );
  }

  return (
    <Card>
      <InlineAlert tone="critical" title="This verification link is not valid">
        The link may have been altered or truncated by your email client. Sign in and resend the
        verification email to get a working link.
      </InlineAlert>
      <BackLinks />
    </Card>
  );
}

function BackLinks() {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
      <Link href="/login" className="inline-flex items-center gap-1.5 text-secondary hover:text-[color:var(--content-primary)]">
        Go to sign in
      </Link>
      <span className="text-muted">·</span>
      <Link href="/forgot-password" className="inline-flex items-center gap-1.5 text-secondary hover:text-[color:var(--content-primary)]">
        Reset your password instead
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <section className="w-full max-w-[460px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-card border border-[color:var(--surface-border)] bg-[color:var(--surface-raised)]">
            <MailWarning className="h-4 w-4 text-[color:var(--tone-info)]" />
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight">Email verification</h1>
        </div>

        {/* useSearchParams must sit inside a Suspense boundary for prerendering. */}
        <Suspense fallback={<Skeleton className="h-40 w-full" />}>
          <VerifyEmailResult />
        </Suspense>
      </section>
    </main>
  );
}
