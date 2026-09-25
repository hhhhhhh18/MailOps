"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Bell,
  Bot,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldX,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button, Badge, Spinner } from "@/components/ui/primitives";
import { VerificationBanner } from "@/components/domain/verification";
import { useLogout, useMe, useNotificationCounts, useScanStatus, useTriggerScan } from "@/lib/hooks";
import { cn, formatDuration, formatRelative } from "@/lib/utils";

/**
 * Application shell.
 *
 * Desktop gets a persistent sidebar; mobile gets a drawer plus a bottom bar,
 * because a job search is exactly the kind of product people check on a phone.
 * The shell also owns the single auth gate: everything inside it is only rendered
 * for an authenticated session.
 */

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/applications", label: "Applications", icon: Sparkles },
  { href: "/emails", label: "Emails", icon: Mail },
  { href: "/rejected", label: "Rejected", icon: ShieldX },
  { href: "/cleanup", label: "Cleanup", icon: Trash2 },
  { href: "/notifications", label: "Notifications", icon: Bell, badgeKey: "unread" as const },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/audit", label: "Audit log", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

const MOBILE_ITEMS = NAV_ITEMS.filter((item) =>
  ["/dashboard", "/applications", "/emails", "/notifications", "/settings"].includes(item.href),
);

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: me, isLoading, isError } = useMe();
  const { data: counts } = useNotificationCounts();
  const logout = useLogout();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Auth gate: an unauthenticated session is sent to sign-in, preserving intent.
  useEffect(() => {
    if (!isLoading && (isError || !me?.user)) {
      router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
    }
  }, [isLoading, isError, me, router, pathname]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted">
          <Spinner /> Loading MailOps…
        </div>
      </div>
    );
  }

  if (!me?.user) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6 text-center">
        <div className="space-y-3">
          <p className="text-sm text-[color:var(--content-primary)]">Redirecting to sign in…</p>
          <Link href="/login" className="text-xs text-[color:var(--tone-accent)] underline">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  const unread = counts?.unread ?? 0;

  return (
    <div className="flex min-h-screen bg-[color:var(--surface-base)]">
      {/* ---------------- Desktop sidebar ---------------- */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-[color:var(--surface-border)] bg-[color:var(--surface-raised)] lg:flex">
        <Brand />
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} badge={item.badgeKey === "unread" ? unread : 0} />
          ))}
        </nav>
        <UserFooter
          name={me.user.name ?? me.user.email}
          email={me.user.email}
          isDemo={me.user.isDemo}
          onLogout={() => logout.mutate(undefined, { onSettled: () => router.replace("/login") })}
          loggingOut={logout.isPending}
        />
      </aside>

      {/* ---------------- Mobile drawer ---------------- */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
          <aside className="relative z-10 flex h-full w-72 flex-col border-r border-[color:var(--surface-border)] bg-[color:var(--surface-raised)]">
            <div className="flex items-center justify-between border-b border-[color:var(--surface-border)] pr-2">
              <Brand />
              <Button size="icon" variant="ghost" onClick={() => setDrawerOpen(false)} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
              {NAV_ITEMS.map((item) => (
                <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} badge={item.badgeKey === "unread" ? unread : 0} />
              ))}
            </nav>
            <UserFooter
              name={me.user.name ?? me.user.email}
              email={me.user.email}
              isDemo={me.user.isDemo}
              onLogout={() => logout.mutate(undefined, { onSettled: () => router.replace("/login") })}
              loggingOut={logout.isPending}
            />
          </aside>
        </div>
      )}

      {/* ---------------- Main column ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          onOpenDrawer={() => setDrawerOpen(true)}
          userEmail={me.user.email}
          isDemo={me.user.isDemo}
          unread={unread}
          gmailConnected={me.gmailAccounts.some((account) => account.status === "CONNECTED")}
        />

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-24 pt-5 lg:px-6 lg:pb-10">
          {/*
            Unverified email is shown on every authenticated page rather than only
            in Settings: verification gates nothing, so it would otherwise be easy
            to ignore indefinitely.
          */}
          {me?.user && !me.user.emailVerified && (
            <div className="mb-4">
              <VerificationBanner email={me.user.email} />
            </div>
          )}
          {children}
        </main>
      </div>

      {/* ---------------- Mobile bottom nav ---------------- */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-[color:var(--surface-border)] bg-[color:var(--surface-raised)]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {MOBILE_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "relative flex flex-1 flex-col items-center gap-1 py-2.5 text-2xs",
                active ? "text-[color:var(--tone-accent)]" : "text-muted",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="truncate">{item.label}</span>
              {item.badgeKey === "unread" && unread > 0 && (
                <span className="absolute right-4 top-1.5 h-1.5 w-1.5 rounded-full bg-[color:var(--tone-critical)]" />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/" || pathname.startsWith("/dashboard");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-4 py-4">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[color:var(--tone-accent-bg)] text-[color:var(--tone-accent)]">
        <Bot className="h-4 w-4" />
      </span>
      <span>
        <span className="block text-sm font-semibold leading-none tracking-tight">MailOps</span>
        <span className="block text-2xs text-muted">Job-application agent</span>
      </span>
    </Link>
  );
}

function NavLink({
  item,
  active,
  badge,
}: {
  item: { href: string; label: string; icon: typeof Mail };
  active: boolean;
  badge: number;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-[color:var(--tone-accent-bg)] font-medium text-[color:var(--tone-accent)]"
          : "text-secondary hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--content-primary)]",
      )}
    >
      <span className="flex items-center gap-2.5">
        <Icon className="h-4 w-4" />
        {item.label}
      </span>
      {badge > 0 && <span className="rounded-full bg-[color:var(--tone-critical)] px-1.5 text-2xs font-medium text-white">{badge}</span>}
    </Link>
  );
}

function UserFooter({
  name,
  email,
  isDemo,
  onLogout,
  loggingOut,
}: {
  name: string;
  email: string;
  isDemo: boolean;
  onLogout: () => void;
  loggingOut: boolean;
}) {
  return (
    <div className="border-t border-[color:var(--surface-border)] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{name}</p>
          <p className="truncate text-2xs text-muted">{email}</p>
        </div>
        <Button size="icon" variant="ghost" onClick={onLogout} loading={loggingOut} aria-label="Sign out" title="Sign out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
      {isDemo && (
        <Badge tone="waiting" className="mt-2">
          Demo account — read only
        </Badge>
      )}
    </div>
  );
}

/**
 * Top bar. Doubles as the scan status strip, which is how the user knows MailOps
 * is actually doing something (spec #20: "Last scan / Next scan").
 */
function TopBar({
  onOpenDrawer,
  userEmail,
  isDemo,
  unread,
  gmailConnected,
}: {
  onOpenDrawer: () => void;
  userEmail: string;
  isDemo: boolean;
  unread: number;
  gmailConnected: boolean;
}) {
  const { data } = useScanStatus();
  const triggerScan = useTriggerScan();
  const schedule = data?.schedule;

  const nextScanMs = schedule?.nextScanAt ? new Date(schedule.nextScanAt).getTime() - Date.now() : null;

  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--surface-border)] bg-[color:var(--surface-base)]/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1400px] items-center gap-3 px-4 py-2.5 lg:px-6">
        <Button size="icon" variant="ghost" onClick={onOpenDrawer} className="lg:hidden" aria-label="Open navigation">
          <Menu className="h-4 w-4" />
        </Button>

        <div className="min-w-0 flex-1">
          {schedule?.scanningEnabled ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--tone-success)]" />
                Last scan {schedule.lastScanAt ? formatRelative(schedule.lastScanAt) : "not yet run"}
              </span>
              {nextScanMs !== null && nextScanMs > 0 && <span>Next scan {formatDuration(nextScanMs)}</span>}
              {schedule.lastScanError && <span className="text-[color:var(--tone-critical)]">Scan issue: {schedule.lastScanError}</span>}
            </div>
          ) : (
            <p className="text-2xs text-muted">
              {gmailConnected ? "Scanning is paused in your settings" : "Gmail not connected — MailOps is not scanning your inbox"}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!isDemo && gmailConnected && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => triggerScan.mutate({})}
              loading={triggerScan.isPending}
              title="Scan now"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Scan now</span>
            </Button>
          )}

          <Link
            href="/notifications"
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[color:var(--surface-hover)] hover:text-[color:var(--content-primary)]"
            aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
          >
            <Bell className="h-4 w-4" />
            {unread > 0 && (
              <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[color:var(--tone-critical)] px-1 text-[9px] font-semibold text-white">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </Link>

          <span className="hidden text-2xs text-muted sm:inline">{userEmail}</span>
        </div>
      </div>
    </header>
  );
}
