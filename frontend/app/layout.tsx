import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "MailOps — AI job-application operations agent",
    template: "%s · MailOps",
  },
  description:
    "MailOps connects to your Gmail, understands incoming mail, and turns recruitment emails into a persistent, organised application timeline — so critical opportunities never get missed.",
  applicationName: "MailOps",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d10",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[color:var(--surface-base)] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
