import { PrismaClient } from "@prisma/client";
import { env, isProduction } from "./env";
import { logger } from "./logger";

/**
 * Single PrismaClient per process. Both the API and the workers import this.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction
      ? [{ emit: "event", level: "error" }]
      : [
          { emit: "event", level: "error" },
          { emit: "event", level: "warn" },
        ],
  });

prisma.$on("error" as never, (e: unknown) => {
  logger.error({ err: e }, "prisma error");
});

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/**
 * Readiness probe for PostgreSQL.
 *
 * Bounded by a timeout because Prisma will otherwise wait for its connection
 * pool timeout when the database is unreachable, which would make /health hang
 * exactly when an operator needs it most.
 */
export async function checkDatabase(timeoutMs = 2500): Promise<{ ok: boolean; error?: string }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`database check timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export const databaseUrl = env.DATABASE_URL;
