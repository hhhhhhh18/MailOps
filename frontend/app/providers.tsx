"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/feedback";
import { ApiError } from "@/lib/api";

/**
 * Query client configuration.
 *
 * Retry policy is deliberate: MailOps talks to integrations that fail
 * independently (Gmail, Slack, WhatsApp). Auth and validation failures must not
 * be retried at all, transient 5xx and network errors get a couple of attempts
 * with backoff, and nothing retries forever — a stuck spinner is worse than an
 * honest error.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            if (error.needsSignIn || error.status === 403 || error.status === 422 || error.status === 404) return false;
            if (error.retryable) return failureCount < 2;
            return false;
          }
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
