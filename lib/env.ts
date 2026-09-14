import { z } from "zod";

/**
 * Server-side environment, validated once on first access.
 *
 * Read lazily (not at import time) so `next build` does not require runtime
 * secrets. Never import this from a client component.
 */
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

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(3),

  // Auth.js reads AUTH_SECRET / AUTH_GOOGLE_* itself; they are validated here too so a
  // misconfiguration fails loudly. AUTH_URL is the public origin used in emailed links.
  AUTH_SECRET: z.string().min(32),
  AUTH_URL: z.url().default("http://localhost:3000"),
  AUTH_GOOGLE_ID: z.string().min(1).optional(),
  AUTH_GOOGLE_SECRET: z.string().min(1).optional(),

  // resend: real delivery. log: write to the server log. test: in-memory outbox for E2E.
  EMAIL_TRANSPORT: z.enum(["resend", "log", "test"]).default("log"),
  RESEND_API_KEY: z.string().min(1).optional(),
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
