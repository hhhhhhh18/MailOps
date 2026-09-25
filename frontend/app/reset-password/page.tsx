"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, KeyRound, ShieldCheck } from "lucide-react";
import { Button, Card, InlineAlert, Input, Skeleton } from "@/components/ui/primitives";
import { useResetPassword } from "@/lib/hooks";
import { ApiError } from "@/lib/api";
import { PASSWORD_MIN_LENGTH, describePasswordProblem } from "@/lib/utils";

/**
 * Password reset completion.
 *
 * The token arrives in the URL fragment of the emailed link and is sent to the
 * API only in the POST body. A missing, used or expired token produces the same
 * single error — the page never distinguishes between them.
 */
function ResetPasswordForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const reset = useResetPassword();

  const policyProblem = password ? describePasswordProblem(password) : null;
  const mismatch = confirm.length > 0 && confirm !== password;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);

    if (policyProblem) {
      setFormError(policyProblem);
      return;
    }
    if (password !== confirm) {
      setFormError("Both passwords must match");
      return;
    }

    try {
      await reset.mutateAsync({ token, newPassword: password });
      setDone(true);
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : "This password reset link is invalid or has expired",
      );
    }
  }

  if (!token) {
    return (
      <Card>
        <InlineAlert tone="critical" title="Missing reset token">
          This link is incomplete. Request a new password reset email and use the button inside it.
        </InlineAlert>
        <div className="mt-4">
          <Link
            href="/forgot-password"
            className="inline-flex items-center gap-1.5 text-xs text-secondary hover:text-[color:var(--content-primary)]"
          >
            <ArrowLeft className="h-3 w-3" /> Request a new link
          </Link>
        </div>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <div className="space-y-4">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--tone-success)]" />
            <div className="text-xs text-secondary">
              <p className="font-medium text-[color:var(--content-primary)]">Password updated</p>
              <p className="mt-1">
                Your password has been changed and every signed-in session has been signed out. Sign in
                again with your new password.
              </p>
            </div>
          </div>
          <Button variant="primary" className="w-full" onClick={() => router.push("/login")}>
            Continue to sign in
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={onSubmit} className="space-y-4">
        {formError && (
          <InlineAlert tone="critical" title="Could not reset your password">
            {formError}
          </InlineAlert>
        )}

        <label className="block">
          <span className="text-xs font-medium text-secondary">New password</span>
          <Input
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            className="mt-1.5"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
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
          {mismatch && <span className="mt-1 block text-2xs text-[color:var(--tone-critical)]">Passwords do not match.</span>}
        </label>

        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={reset.isPending}
          disabled={!password || !confirm || Boolean(policyProblem) || mismatch}
        >
          Set new password
        </Button>
      </form>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <section className="w-full max-w-[420px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-card border border-[color:var(--surface-border)] bg-[color:var(--surface-raised)]">
            <KeyRound className="h-4 w-4 text-[color:var(--tone-info)]" />
          </span>
          <h1 className="mt-3 text-lg font-semibold tracking-tight">Choose a new password</h1>
          <p className="mt-1 text-xs text-muted">
            This link can be used once and expires shortly after it was sent.
          </p>
        </div>

        {/* useSearchParams must sit inside a Suspense boundary for prerendering. */}
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <ResetPasswordForm />
        </Suspense>
      </section>
    </main>
  );
}
