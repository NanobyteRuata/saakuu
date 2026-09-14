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
