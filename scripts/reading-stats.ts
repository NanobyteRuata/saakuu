/**
 * Phase 23: what recent readings were given and what they used, newest first. Read-only.
 *
 *   pnpm ai:stats [count]
 *
 * One line per extraction run and per field proposal: the model, the image detail it was read at,
 * and its tokens — page images and prompt text going in, thinking and the answer coming out — with
 * the cost at list price. It exists to compare readings of the same page across AI_THINKING
 * settings and prompt versions; operators are never shown tokens or money (decision 79).
 */
import { PrismaClient } from "@prisma/client";

import { modelPrice } from "@/lib/ai/models";
import { loadDotEnv } from "@/lib/env";

loadDotEnv();
const prisma = new PrismaClient();

const select = {
  id: true,
  model: true,
  promptVersion: true,
  state: true,
  thinkingLevel: true,
  inputTokens: true,
  outputTokens: true,
  imageTokens: true,
  thinkingTokens: true,
  photoIds: true,
  createdAt: true,
} as const;

const num = (n: number | null): string => (n === null ? "-" : n.toLocaleString("en-US"));
const minus = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b);

async function main(): Promise<void> {
  const take = Math.min(Math.max(Number(process.argv[2]) || 20, 1), 200);
  const [runs, proposals] = await Promise.all([
    prisma.extractionRun.findMany({ where: { inputTokens: { not: null } }, orderBy: { createdAt: "desc" }, take, select }),
    prisma.fieldProposal.findMany({ where: { inputTokens: { not: null } }, orderBy: { createdAt: "desc" }, take, select }),
  ]);
  const readings = [...runs.map((r) => ({ ...r, what: "extract" })), ...proposals.map((p) => ({ ...p, what: "propose" }))]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, take);

  console.table(
    readings.map((r) => {
      const price = modelPrice(r.model, r.createdAt);
      const usd = price ? ((r.inputTokens ?? 0) * price.inputPricePerMTok + (r.outputTokens ?? 0) * price.outputPricePerMTok) / 1_000_000 : null;
      return {
        when: r.createdAt.toISOString().slice(0, 16).replace("T", " "),
        what: r.what,
        id: r.id.slice(-6),
        model: r.model,
        prompt: r.promptVersion,
        state: r.state,
        thinking: r.thinkingLevel ?? "-",
        pages: r.photoIds.length,
        "in: image": num(r.imageTokens),
        "in: text": num(minus(r.inputTokens, r.imageTokens)),
        // The provider leaves the thinking count out when there was none to report.
        "out: thinking": num(r.outputTokens === null ? null : (r.thinkingTokens ?? 0)),
        "out: answer": num(minus(r.outputTokens, r.thinkingTokens ?? 0)),
        usd: usd === null ? "-" : `$${usd.toFixed(4)}`,
      };
    }),
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
