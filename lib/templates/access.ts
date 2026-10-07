import type { Prisma } from "@prisma/client";

import { requireUserId } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";

import { computeConfigState } from "./config-state";
import type { ConfigState } from "./schemas";

export type Db = Prisma.TransactionClient;

const TEMPLATE_NOT_FOUND = "That template doesn't exist or you don't have access to it.";

/** Live books the user owns. Templates and fields are reached only through these. */
function ownedBook(userId: string) {
  return { userId, deletedAt: null } satisfies Prisma.BookWhereInput;
}

/** Ownership guard for a live template: its book must be live and owned by the user. */
export async function requireTemplateAccess(
  userId: string | null | undefined,
  templateId: string,
  db: Db = prisma,
): Promise<{ id: string; bookId: string }> {
  const uid = requireUserId(userId);
  const template = await db.template.findFirst({
    where: { id: templateId, deletedAt: null, book: ownedBook(uid) },
    select: { id: true, bookId: true },
  });
  if (!template) throw new AppError("NOT_FOUND", TEMPLATE_NOT_FOUND);
  return template;
}

/** A field on a live template the user owns. `deleted` picks live (false) or soft-deleted (true) fields. */
export async function requireFieldAccess(
  userId: string | null | undefined,
  fieldId: string,
  deleted: boolean,
): Promise<{ id: string; templateId: string }> {
  const uid = requireUserId(userId);
  const field = await prisma.field.findFirst({
    where: {
      id: fieldId,
      deletedAt: deleted ? { not: null } : null,
      template: { deletedAt: null, book: ownedBook(uid) },
    },
    select: { id: true, templateId: true },
  });
  if (!field) {
    throw new AppError(
      "NOT_FOUND",
      deleted ? "That field isn't in the deleted list any more. Reload the page." : "That field doesn't exist or was deleted.",
    );
  }
  return field;
}

/**
 * Locks the template row for the rest of the transaction. Every structural change (positions,
 * deletes, restores, sequence field) takes this lock, so concurrent edits can't compute the same
 * fractional position or confirm stale counts.
 */
export async function lockTemplate(tx: Db, templateId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Template" WHERE id = ${templateId} AND "deletedAt" IS NULL FOR UPDATE`;
  if (rows.length === 0) throw new AppError("NOT_FOUND", TEMPLATE_NOT_FOUND);
}

/**
 * Marks the part of the template a reading depends on as changed (decision 78): fields and
 * the settings that go into the prompt. A test reading older than this is stale. Mapping changes don't
 * call it, which is why it isn't `updatedAt`: every mapping save touches the template row.
 */
export async function markSourceChanged(tx: Db, templateId: string): Promise<void> {
  const now = new Date();
  await tx.template.update({ where: { id: templateId }, data: { fieldsChangedAt: now, updatedAt: now } });
}

/** Recomputes and stores `Template.configState`. Call in the same transaction as the change. */
export async function recomputeConfigState(tx: Db, templateId: string): Promise<ConfigState> {
  const liveFields = await tx.field.count({ where: { templateId, deletedAt: null } });
  const mappings = await tx.mapping.count({ where: { templateId } });
  const brokenMappings = await tx.mapping.count({ where: { templateId, state: "BROKEN" } });
  const configState = computeConfigState({ liveFields, mappings, brokenMappings });
  await tx.template.update({ where: { id: templateId }, data: { configState } });
  return configState;
}
