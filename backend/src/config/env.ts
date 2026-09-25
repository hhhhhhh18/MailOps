import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : v === "true" || v === "1"));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(4000),
  API_BASE_URL: z.string().default("http://localhost:4000"),
  WEB_BASE_URL: z.string().default("http://localhost:3000"),

  /**
   * Password-reset link lifetime, in minutes.
   *
   * Deliberately short: a reset link is a bearer credential delivered over email,
   * so the window in which a leaked inbox item is useful is kept small (default
   * 30 minutes). Configurable per deployment, never per request.
   */
  PASSWORD_RESET_TTL_MINUTES: int(30),

  /**
   * Email-verification link lifetime, in minutes (default 24 hours).
   *
   * Longer than a password reset on purpose: verification is not a credential
   * change, and a user may not open the link until the next day. It still expires,
   * so an address that is later recycled by a mail provider cannot be verified
   * with a stale link.
   */
  EMAIL_VERIFICATION_TTL_MINUTES: int(1440),

  DATABASE_URL: z.string().default("postgresql://mailops:mailops@localhost:5432/mailops?schema=public"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  JWT_SECRET: z.string().default("dev-only-insecure-secret-change-me"),
  JWT_ACCESS_TTL_SECONDS: int(900),
  JWT_REFRESH_TTL_DAYS: int(30),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool(false),

  ENCRYPTION_KEY: z.string().default(""),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().default("http://localhost:4000/api/gmail/oauth/callback"),
  GMAIL_SYNC_LOOKBACK_DAYS: int(120),
  GMAIL_MAX_MESSAGES_PER_SCAN: int(200),

  AI_PROVIDER: z.enum(["heuristic", "openai-compatible"]).default("heuristic"),
  AI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("gpt-4o-mini"),
  AI_REQUEST_TIMEOUT_MS: int(25000),
  AI_MIN_CONFIDENCE: z.string().default("0.7").transform(Number),
  AI_REVIEW_THRESHOLD: z.string().default("0.55").transform(Number),

  SLACK_WEBHOOK_URL: z.string().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),

  WHATSAPP_PROVIDER: z.string().default("cloud-api"),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_DEFAULT_TO: z.string().optional(),

  VOICE_PROVIDER: z.string().default("twilio"),
  VOICE_ACCOUNT_SID: z.string().optional(),
  VOICE_AUTH_TOKEN: z.string().optional(),
  VOICE_FROM_NUMBER: z.string().optional(),

  EMAIL_CHANNEL_PROVIDER: z.string().default("console"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default("MailOps <no-reply@mailops.local>"),

  RATE_LIMIT_WINDOW_MS: int(60000),
  RATE_LIMIT_MAX: int(120),
  AUTH_RATE_LIMIT_MAX: int(10),

  WORKER_CONCURRENCY: int(4),
  SCHEDULER_ENABLED: bool(true),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type AppEnv = z.infer<typeof envSchema>;

function loadEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Fail loud and early: a misconfigured process must not silently half-start.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  if (env.NODE_ENV === "production") {
    // Refuse insecure production configuration rather than logging a warning.
    const weak: string[] = [];
    if (!process.env.JWT_SECRET || env.JWT_SECRET.length < 32) weak.push("JWT_SECRET (min 32 chars)");
    if (!process.env.ENCRYPTION_KEY) weak.push("ENCRYPTION_KEY");
    if (!env.COOKIE_SECURE) weak.push("COOKIE_SECURE=true");
    if (weak.length) {
      throw new Error(`Refusing to start in production with insecure config: ${weak.join(", ")}`);
    }
  }

  return env;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
export const isDevelopment = env.NODE_ENV === "development";

/** True when a real Google OAuth client is configured. */
export const googleOAuthConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/** True when a real AI provider is configured. */
export const aiProviderConfigured = env.AI_PROVIDER !== "heuristic" && Boolean(env.AI_API_KEY);
