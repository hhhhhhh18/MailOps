"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Bot, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { Button, Card, InlineAlert, Input, Skeleton } from "@/components/ui/primitives";
import { useLogin, useMe, useRegister } from "@/lib/hooks";
import { ApiError } from "@/lib/api";

/**
 * Sign-in / sign-up.
 *
 * Two entry points in one screen: authentication for the MailOps account, and a
 * clear explanation that Gmail access is a separate, explicit consent step that
 * happens later from Settings. Keeping those distinct is a privacy requirement,
 * not a UX preference.
 *
 * `useSearchParams` must sit inside a Suspense boundary for the page to be
 * statically prerenderable, hence the split below.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center p-8">
          <Skeleton className="h-80 w-full max-w-sm" />
        </div>
      }
    >
      <LoginScreen />
    </Suspense>
  );
}

function LoginScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("returnTo") ?? "/dashboard";
  /** Set by the Danger Zone after a successful account deletion. */
  const justDeleted = searchParams.get("deleted") === "1";

  const { data: me } = useMe();
  const login = useLogin();
  const register = useRegister();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<ApiError | null>(null);

  // Already signed in? Skip the form entirely.
  useEffect(() => {
    if (me?.user) router.replace(returnTo);
  }, [me, router, returnTo]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    const onError = (error: unknown) => {
      setFormError(
        error instanceof ApiError
          ? error
          : new ApiError({ message: "Something went wrong. Please try again.", code: "UNKNOWN", status: 0 }),
      );
    };

    if (mode === "login") {
      login.mutate({ email, password }, { onSuccess: () => router.replace(returnTo), onError });
    } else {
      register.mutate({ email, password, name: name || undefined }, { onSuccess: () => router.replace(returnTo), onError });
    }
  };

  const pending = login.isPending || register.isPending;

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      {/* ---- Marketing / value panel ---- */}
      <section className="relative flex flex-1 flex-col justify-between border-b border-[color:var(--surface-border)] px-8 py-10 lg:border-b-0 lg:border-r lg:px-14 lg:py-14">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[color:var(--tone-accent-bg)] text-[color:var(--tone-accent)]">
            <Bot className="h-4.5 w-4.5" />
          </span>
          <div>
            <p className="text-sm font-semibold leading-none">MailOps</p>
            <p className="text-2xs text-muted">AI job-application operations agent</p>
          </div>
        </div>

        <div className="my-10 max-w-lg">
          <h1 className="text-2xl font-semibold leading-snug tracking-tight text-[color:var(--content-primary)] sm:text-3xl">
            Your job search runs on email. MailOps makes sure you never miss it.
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-secondary">
            MailOps reads your inbox, recognises recruitment email, and turns it into a persistent application timeline —
            then escalates the things that actually matter until you acknowledge them.
          </p>

          <ul className="mt-8 space-y-4">
            <Feature
              icon={<Sparkles className="h-4 w-4" />}
              title="Understands, not just sorts"
              body="Separates shortlists, assessments and interviews from promotional noise, and extracts structured application facts."
            />
            <Feature
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Never deletes without you"
              body="Cleanup is proposed, you approve it. Job, personal and financial mail is protected server-side."
            />
            <Feature
              icon={<Zap className="h-4 w-4" />}
              title="Escalates until you look"
              body="Dashboard first, then Slack or WhatsApp, and an opt-in AI voice call for genuinely critical updates."
            />
          </ul>
        </div>

        <p className="text-2xs text-muted">
          MailOps never sends email on your behalf, never asks for full mailbox access, and can be disconnected at any time.
        </p>
      </section>

      {/* ---- Auth form ---- */}
      <section className="flex flex-1 items-center justify-center px-6 py-12 lg:px-10">
        <div className="w-full max-w-sm">
          <Card
            title={mode === "login" ? "Sign in to MailOps" : "Create your MailOps account"}
            description={
              mode === "login"
                ? "Use the account you registered with MailOps. Gmail is connected separately."
                : "Your account is separate from Gmail — you will grant mailbox access in the next step."
            }
          >
            {justDeleted && (
              <div className="mb-4">
                <InlineAlert tone="info" title="Your account has been deleted">
                  Everything MailOps stored for that account has been erased, and you have been signed
                  out. Any messages already delivered to Slack, WhatsApp, email or voice cannot be
                  recalled, and any Google access that could not be revoked should be checked in your
                  Google account permissions.
                </InlineAlert>
              </div>
            )}

            <form onSubmit={submit} className="space-y-4">
              {mode === "register" && (
                <Input
                  label="Name"
                  name="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                />
              )}

              <Input
                label="Email"
                name="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />

              <Input
                label="Password"
                name="password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={mode === "register" ? "At least 10 characters, with a number" : "Your password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                hint={mode === "register" ? "Minimum 10 characters, including at least one letter and one number." : undefined}
              />

              {mode === "login" && (
                <div className="flex justify-end">
                  <Link
                    href="/forgot-password"
                    className="text-xs font-medium text-[color:var(--tone-accent)] hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
              )}

              {formError && (
                <InlineAlert tone={formError.degraded ? "waiting" : "critical"} title={formError.message}>
                  {formError.retryable && <span className="text-muted">This looks temporary — try again in a moment.</span>}
                  {formError.requestId && <span className="block font-mono text-2xs text-muted">ref: {formError.requestId}</span>}
                </InlineAlert>
              )}

              <Button type="submit" variant="primary" size="lg" className="w-full" loading={pending}>
                {mode === "login" ? "Sign in" : "Create account"}
              </Button>
            </form>

            <div className="mt-4 flex items-center justify-between text-xs">
              <span className="text-muted">{mode === "login" ? "New to MailOps?" : "Already have an account?"}</span>
              <button
                type="button"
                className="font-medium text-[color:var(--tone-accent)] hover:underline"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setFormError(null);
                }}
              >
                {mode === "login" ? "Create an account" : "Sign in instead"}
              </button>
            </div>
          </Card>

        </div>
      </section>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[color:var(--surface-overlay)] text-[color:var(--tone-accent)]">
        {icon}
      </span>
      <div>
        <p className="text-sm font-medium text-[color:var(--content-primary)]">{title}</p>
        <p className="mt-0.5 text-xs text-muted">{body}</p>
      </div>
    </li>
  );
}
