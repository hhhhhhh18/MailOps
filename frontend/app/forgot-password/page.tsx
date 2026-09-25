"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound, MailCheck } from "lucide-react";
import { Button, Card, InlineAlert, Input } from "@/components/ui/primitives";
import { useForgotPassword } from "@/lib/hooks";
import { ApiError } from "@/lib/api";

/**
 * Password reset request.
 *
 * The success state is intentionally generic: it states that a link has been sent
 * *if* an account exists, and never confirms whether the address is registered.
 * The server behaves identically for a known address, an unknown one, and the
 * shared demo account.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const forgot = useForgotPassword();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    try {
      await forgot.mutateAsync({ email: email.trim() });
      setSubmitted(true);
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : "Could not send the reset link. Please try again.",
      );
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <section className="w-full max-w-[420px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-card border border-[color:var(--surface-border)] bg-[color:var(--surface-raised)]">
            <KeyRound className="h-4 w-4 text-[color:var(--tone-info)]" />
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight">Reset your password</h1>
          <p className="mt-1 text-xs text-muted">
            Enter the email address on your MailOps account and we will send a reset link.
          </p>
        </div>

        <Card>
          {submitted ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2">
                <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--tone-success)]" />
                <div className="text-xs text-secondary">
                  <p className="font-medium text-[color:var(--content-primary)]">Check your inbox</p>
                  <p className="mt-1">
                    If an account exists for <span className="font-mono">{email.trim()}</span>, a
                    password reset link has been sent. The link expires shortly and can be used once.
                  </p>
                </div>
              </div>
              <InlineAlert tone="info" title="Nothing arrived?">
                Check your spam folder, or try again in a few minutes. For security we do not reveal
                whether an address is registered.
              </InlineAlert>
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 text-xs text-secondary hover:text-[color:var(--content-primary)]"
              >
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              {formError && <InlineAlert tone="critical" title="Could not send the link">{formError}</InlineAlert>}

              <label className="block">
                <span className="text-xs font-medium text-secondary">Email address</span>
                <Input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  className="mt-1.5"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>

              <Button type="submit" variant="primary" className="w-full" loading={forgot.isPending} disabled={!email.trim()}>
                Send reset link
              </Button>

              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 text-xs text-secondary hover:text-[color:var(--content-primary)]"
              >
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </Link>
            </form>
          )}
        </Card>
      </section>
    </main>
  );
}
