import { loadDotEnv } from "@/lib/env";

loadDotEnv();

/**
 * Runs the storage cleanup the worker schedules daily (lib/storage/lifecycle.ts).
 *
 *   pnpm storage:cleanup              purge, due deletions, sweep
 *   pnpm storage:cleanup --dry-run    report what would be deleted, delete nothing
 *   pnpm storage:cleanup --now=2026-12-01T00:00:00Z
 *                                     act as if it were that time (to check grace periods by hand)
 */
async function main(): Promise<void> {
  const { prisma } = await import("@/lib/db/client");
  const { runStorageCleanup } = await import("@/lib/storage/lifecycle");
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const nowArg = args.find((a) => a.startsWith("--now="))?.slice("--now=".length);
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now is not a date: ${nowArg ?? ""}`);
  try {
    const result = await runStorageCleanup({ dryRun, now });
    console.log(JSON.stringify({ dryRun, now: now.toISOString(), ...result }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
