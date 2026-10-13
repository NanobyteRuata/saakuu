import type { Prisma } from "@prisma/client";

import { READING_KEY_START, readingKey } from "@/lib/ai/reading-key";
import { buildTemplateSnapshot } from "@/lib/ai/snapshot";
import { requireUserId } from "@/lib/auth/guards";
import { prisma } from "@/lib/db/client";
import { AppError } from "@/lib/errors";

import { computeConfigState } from "./config-state";
import { MAX_FIELDS, type ConfigState } from "./schemas";
import { fieldSelect, toFieldView } from "./views";

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

/** The fingerprint of what the AI is told about this template as it stands now (`lib/ai/reading-key.ts`). */
async function currentReadingKey(tx: Db, templateId: string): Promise<string> {
  const [template, fields] = await Promise.all([
    tx.template.findUniqueOrThrow({
      where: { id: templateId },
      select: { id: true, kind: true, languageHint: true, instructions: true, anchors: true },
    }),
    tx.field.findMany({ where: { templateId, deletedAt: null }, select: fieldSelect, take: MAX_FIELDS }),
  ]);
  return readingKey(buildTemplateSnapshot(template, fields.map(toFieldView)));
}

/**
 * Locks the template row for the rest of the transaction. Every structural change (positions,
 * deletes, restores, sequence field) takes this lock, so concurrent edits can't compute the same
 * fractional position or confirm stale counts.
 *
 * It is also where a template's fingerprint is first taken (decision 89). A template from before
 * Phase 28 has none, and its read documents carry `start`: here, before the change the caller is
 * about to make, the template gets its real fingerprint and those documents get the same one. So
 * nothing is flagged until something really changes, and undoing that change clears the flag.
 */
export async function lockTemplate(tx: Db, templateId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string; readingKey: string | null }[]>`
    SELECT id, "readingKey" FROM "Template" WHERE id = ${templateId} AND "deletedAt" IS NULL FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new AppError("NOT_FOUND", TEMPLATE_NOT_FOUND);
  if (row.readingKey !== null) return;
  const key = await currentReadingKey(tx, templateId);
  await tx.$executeRaw`UPDATE "Template" SET "readingKey" = ${key} WHERE id = ${templateId}`;
  await tx.$executeRaw`UPDATE "Document" SET "readWithKey" = ${key} WHERE "templateId" = ${templateId} AND "readWithKey" = ${READING_KEY_START}`;
}

/**
 * Recomputes the template's fingerprint after a change to what a reading depends on (decision 88):
 * fields and the settings that go into the prompt. A document read under another fingerprint is
 * flagged `fields changed since read`. Call under `lockTemplate`, after the change. A change that
 * leaves what the AI is told as it was (a Manual field, a save of nothing) leaves the fingerprint
 * as it was, and one that is undone brings the old fingerprint back. Mapping changes don't call it.
 */
export async function markSourceChanged(tx: Db, templateId: string): Promise<void> {
  await tx.template.update({ where: { id: templateId }, data: { readingKey: await currentReadingKey(tx, templateId), updatedAt: new Date() } });
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
