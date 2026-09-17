import { z } from "zod";

/**
 * Server-side environment, validated once on first access.
 *
 * Read lazily (not at import time) so `next build` does not require runtime
 * secrets. Never import this from a client component.
 */
/** Unset or empty (docker compose passes `${VAR:-}` as ""), so an optional value stays optional. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Origin the browser uses to reach storage (presigned upload/download URLs). Differs from
  // S3_ENDPOINT when the app talks to storage over an internal network (docker compose).
  S3_PUBLIC_ENDPOINT: optional(z.url()),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(3),
  // Photo ingest/render jobs are CPU-heavy (HEIC decode, PDF render, resize); keep this low.
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),

  // Extraction (Phase 5). `fake` is a deterministic stub for local work and CI; it never calls the network.
  AI_PROVIDER: z.enum(["gemini", "fake"]).default("gemini"),
  // Optional so the app boots without it; a run without a key fails with a plain message.
  GEMINI_API_KEY: optional(z.string().min(1)),
  // `slow` waits 90 s before answering, to test a worker killed mid-job.
  AI_FAKE_BEHAVIOUR: z.enum(["ok", "error", "rate-limited", "slow"]).default("ok"),
  // Documents extracted at once, and model calls per minute across the worker (free tiers are low).
  EXTRACTION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),
  EXTRACTION_RPM: z.coerce.number().int().min(1).max(10_000).default(10),

  // Auth.js reads AUTH_SECRET / AUTH_GOOGLE_* itself; they are validated here too so a
  // misconfiguration fails loudly. AUTH_URL is the public origin used in emailed links.
  AUTH_SECRET: z.string().min(32),
  AUTH_URL: z.url().default("http://localhost:3000"),
  AUTH_GOOGLE_ID: optional(z.string().min(1)),
  AUTH_GOOGLE_SECRET: optional(z.string().min(1)),

  // Request limits on auth and extraction endpoints (lib/rate-limit.ts). Only turn off for local debugging.
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  // Proxies in front of the app that append to X-Forwarded-For; the client address is this many entries from the right.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  // Days a deleted photo's files (and the photos of deleted documents and books) stay in storage.
  // Keep it at least as long as database backups are kept, so a restore never points at missing files.
  PHOTO_DELETE_GRACE_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

  // resend: real delivery. log: write to the server log. test: in-memory outbox for E2E.
  EMAIL_TRANSPORT: z.enum(["resend", "log", "test"]).default("log"),
  RESEND_API_KEY: optional(z.string().min(1)),
  EMAIL_FROM: z.string().min(3).default("SaaKuu <onboarding@resend.dev>"),
}).superRefine((env, ctx) => {
  if (env.EMAIL_TRANSPORT === "resend" && !env.RESEND_API_KEY) {
    ctx.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: "required when EMAIL_TRANSPORT=resend" });
  }
  if (env.EMAIL_TRANSPORT === "test" && env.NODE_ENV === "production") {
    ctx.addIssue({ code: "custom", path: ["EMAIL_TRANSPORT"], message: "test transport is not allowed in production" });
  }
  if (Boolean(env.AUTH_GOOGLE_ID) !== Boolean(env.AUTH_GOOGLE_SECRET)) {
    ctx.addIssue({ code: "custom", path: ["AUTH_GOOGLE_ID"], message: "set both AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET, or neither" });
  }
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Loads `.env` into process.env for standalone Node entrypoints (worker, scripts).
 * Next.js loads it on its own. A missing file is fine: containers inject env directly.
 */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // no .env file present
  }
}
