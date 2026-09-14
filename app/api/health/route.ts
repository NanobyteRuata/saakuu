import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { createRedisConnection } from "@/lib/queue";
import { checkStorage } from "@/lib/storage/s3";

export const dynamic = "force-dynamic";

type CheckStatus = "ok" | "down";

async function check(name: string, fn: () => Promise<void>): Promise<CheckStatus> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    log.warn("health check failed", { check: name, error: err instanceof Error ? err.message : String(err) });
    return "down";
  }
}

/** Liveness of the app's dependencies. No auth: exposes no data, only up/down. */
export async function GET(): Promise<Response> {
  const [database, redis, storage] = await Promise.all([
    check("database", async () => {
      await prisma.$queryRaw`SELECT 1`;
    }),
    check("redis", async () => {
      const conn = createRedisConnection();
      try {
        await conn.ping();
      } finally {
        conn.disconnect();
      }
    }),
    check("storage", checkStorage),
  ]);

  const checks = { database, redis, storage };
  const healthy = Object.values(checks).every((s) => s === "ok");
  return Response.json({ status: healthy ? "ok" : "degraded", checks }, { status: healthy ? 200 : 503 });
}
