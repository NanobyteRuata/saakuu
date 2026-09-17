import type { Prisma } from "@prisma/client";

import { requireBookAccess, requireUserId } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { lockBook, type Db } from "@/lib/documents/access";
import { AppError } from "@/lib/errors";
import { isBookRevalidationPending } from "@/lib/queue";
import { requestBookRevalidation } from "@/lib/transform/triggers";
import { log } from "@/lib/log";

import { loadRules, loadValidationContext, revalidate, ruleFailureCounts } from "./revalidate";
import { MAX_RULES, ruleProblem, type RuleDraft, type ValidationRuleInput } from "./rules";

/**
 * Validation rules CRUD (docs/04 → Glossary & validation rules). Saving a rule re-checks its column's cells in
 * the same request, so its flags show at once; "Re-check all cells" queues the whole book.
 */

export type RuleView = ValidationRuleInput & {
  /** Cells this rule flags right now (0 while disabled or broken); null when counts weren't asked for. */
  failing: number | null;
  problem: string | null;
};

const RULE_TIMEOUT = 60_000;
const DRAFT_ID = "draft";

async function requireRuleAccess(userId: string, bookId: string, ruleId: string): Promise<{ id: string; bookId: string; outputColumnId: string | null }> {
  const uid = requireUserId(userId);
  const rule = await prisma.validationRule.findFirst({
    where: { id: ruleId, bookId, book: { userId: uid, deletedAt: null } },
    select: { id: true, bookId: true, outputColumnId: true },
  });
  if (!rule) throw new AppError("NOT_FOUND", "That rule doesn't exist or was deleted.");
  return rule;
}

async function views(db: Db, bookId: string, rules: ValidationRuleInput[]): Promise<RuleView[]> {
  const { ctx } = await loadValidationContext(db, bookId, [], false);
  const counts = await ruleFailureCounts(db, bookId, rules.filter((r) => r.enabled));
  return rules.map((r) => ({ ...r, failing: counts.get(r.id) ?? 0, problem: ruleProblem(r, ctx.columns) }));
}

/** The book's rules. Counting failures reads every cell, so a page render skips it and the list fetches counts after. */
export async function listRules(userId: string, bookId: string, options: { counts: boolean } = { counts: true }): Promise<RuleView[]> {
  await requireBookAccess(userId, bookId);
  const rules = await loadRules(prisma, bookId);
  if (options.counts) return views(prisma, bookId, rules);
  const { ctx } = await loadValidationContext(prisma, bookId, [], false);
  return rules.map((r) => ({ ...r, failing: null, problem: ruleProblem(r, ctx.columns) }));
}

async function assertValid(db: Db, bookId: string, draft: RuleDraft): Promise<void> {
  const { ctx } = await loadValidationContext(db, bookId, []);
  const problem = ruleProblem(draft, ctx.columns);
  if (problem) throw new AppError("VALIDATION", problem);
}

function columnsOf(rule: { outputColumnId: string | null }): string[] {
  return rule.outputColumnId ? [rule.outputColumnId] : [];
}

function data(draft: RuleDraft) {
  return {
    outputColumnId: draft.outputColumnId,
    kind: draft.kind,
    params: draft.params satisfies Prisma.InputJsonValue,
    severity: draft.severity,
    message: draft.message,
    enabled: draft.enabled,
  };
}

async function viewOne(db: Db, bookId: string, id: string): Promise<RuleView> {
  const rules = await loadRules(db, bookId);
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new AppError("NOT_FOUND", "That rule doesn't exist or was deleted.");
  const [view] = await views(db, bookId, [rule]);
  if (!view) throw new AppError("INTERNAL");
  return view;
}

export async function createRule(userId: string, bookId: string, draft: RuleDraft): Promise<RuleView> {
  await requireBookAccess(userId, bookId);
  return prisma.$transaction(
    async (tx) => {
      await lockBook(tx, bookId);
      await assertValid(tx, bookId, draft);
      if ((await tx.validationRule.count({ where: { bookId } })) >= MAX_RULES) {
        throw new AppError("VALIDATION", `A book can have up to ${MAX_RULES} rules. Remove one first.`);
      }
      const created = await tx.validationRule.create({ data: { bookId, ...data(draft) }, select: { id: true } });
      await revalidate(tx, bookId, { columnIds: [draft.outputColumnId] });
      return viewOne(tx, bookId, created.id);
    },
    { timeout: RULE_TIMEOUT },
  );
}

export async function updateRule(userId: string, bookId: string, ruleId: string, draft: RuleDraft): Promise<RuleView> {
  const rule = await requireRuleAccess(userId, bookId, ruleId);
  return prisma.$transaction(
    async (tx) => {
      await lockBook(tx, rule.bookId);
      await assertValid(tx, rule.bookId, draft);
      await tx.validationRule.update({ where: { id: ruleId }, data: data(draft) });
      await revalidate(tx, rule.bookId, { columnIds: [...new Set([...columnsOf(rule), draft.outputColumnId])] });
      return viewOne(tx, rule.bookId, ruleId);
    },
    { timeout: RULE_TIMEOUT },
  );
}

export async function deleteRule(userId: string, bookId: string, ruleId: string): Promise<{ deleted: true }> {
  const rule = await requireRuleAccess(userId, bookId, ruleId);
  await prisma.$transaction(
    async (tx) => {
      await lockBook(tx, rule.bookId);
      await tx.validationRule.delete({ where: { id: ruleId } });
      if (rule.outputColumnId) await revalidate(tx, rule.bookId, { columnIds: [rule.outputColumnId] });
    },
    { timeout: RULE_TIMEOUT },
  );
  return { deleted: true };
}

/** How many cells an unsaved rule would flag, or why it can't be saved. Writes nothing. */
export async function previewRule(userId: string, bookId: string, draft: RuleDraft): Promise<{ failing: number; problem: string | null }> {
  await requireBookAccess(userId, bookId);
  const { ctx } = await loadValidationContext(prisma, bookId, []);
  const problem = ruleProblem(draft, ctx.columns);
  if (problem) return { failing: 0, problem };
  const counts = await ruleFailureCounts(prisma, bookId, [{ ...draft, id: DRAFT_ID, enabled: true }]);
  return { failing: counts.get(DRAFT_ID) ?? 0, problem: null };
}

export async function requestRevalidation(userId: string, bookId: string): Promise<{ pending: boolean }> {
  await requireBookAccess(userId, bookId);
  await requestBookRevalidation(bookId);
  return { pending: true };
}

export async function getRevalidationStatus(userId: string, bookId: string): Promise<{ pending: boolean }> {
  await requireBookAccess(userId, bookId);
  const pending = await isBookRevalidationPending(bookId).catch((err: unknown) => {
    log.error("revalidation status failed", err, { bookId });
    return false;
  });
  return { pending };
}
