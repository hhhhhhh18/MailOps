"use client";

import { AppShell } from "@/components/layout/app-shell";

/**
 * Authenticated layout. Every page under `(app)` renders inside the shell, which
 * owns the single auth gate — a page never has to check the session itself.
 */
export default function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
