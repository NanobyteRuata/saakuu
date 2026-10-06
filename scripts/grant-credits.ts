/**
 * Phase 22: add credits to an account by hand (decision 81). Until credits are sold this is how anyone
 * gets more than the free ones: they ask with `Request more`, and whoever runs SaaKuu runs this.
 *
 *   pnpm credits:grant <email> <credits> [note]
 *
 * `credits` is whole or decimal credits (`250`, `12.5`), and may be negative to correct a mistake.
 * It writes one GRANT line to the ledger and takes effect at once: no restart, nothing to redeploy.
 * The note is shown to the user beside the line on their account page.
 */
import { PrismaClient } from "@prisma/client";

import { loadDotEnv } from "@/lib/env";

loadDotEnv();
const prisma = new PrismaClient();

async function main(): Promise<void> {
  const [emailArg, creditsArg, ...noteParts] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();
  const milliCredits = Math.round(Number(creditsArg) * 1000);
  if (!email || !creditsArg || !Number.isFinite(milliCredits) || milliCredits === 0 || Math.abs(milliCredits) > 2_000_000_000) {
    console.error("Usage: pnpm credits:grant <email> <credits> [note]   (credits may be negative, never zero)");
    process.exitCode = 1;
    return;
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    console.error(`No account has the address ${email}.`);
    process.exitCode = 1;
    return;
  }
  const note = noteParts.join(" ").trim() || null;
  await prisma.creditEntry.create({ data: { userId: user.id, kind: "GRANT", milliCredits, note } });
  const total = await prisma.creditEntry.aggregate({ where: { userId: user.id }, _sum: { milliCredits: true } });
  const fmt = (milli: number) => (milli / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 3 });
  console.log(`${milliCredits > 0 ? "Added" : "Removed"} ${fmt(Math.abs(milliCredits))} credits ${milliCredits > 0 ? "to" : "from"} ${email}. Balance: ${fmt(total._sum.milliCredits ?? 0)}.`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
