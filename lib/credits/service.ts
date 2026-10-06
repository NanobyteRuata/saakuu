import type { CreditKind } from "@prisma/client";

import type { AiKeySource } from "@/lib/ai/keys";
import { requireUserId } from "@/lib/auth/guards";
import { getEmailSender } from "@/lib/email/sender";
import { creditRequestMessage } from "@/lib/email/templates";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/db/client";
import type { Db } from "@/lib/documents/access";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";

import { costMicroUsd, creditCount, decideStart, toMilliCredits, type CreditEstimate, type StartDecision } from "./rate";

/**
 * The credit ledger (Phase 22, decision 81). Server-only.
 *
 * A user's balance is the sum of their `CreditEntry` rows. What their queued and running readings are
 * holding is `reservedMilliCredits` on those runs and proposals, and what they can start with is the
 * balance less those holds. Nothing here refunds anything: a reading that fails, is reaped or loses
 * its document stops being active, and its hold goes with it. Only a completed reading writes a row.
 *
 * Usage is recorded on every deployment, enforced or not, so the history a price is set from exists
 * before the switch is thrown. A reading on a personal key is the user's own bill and never appears.
 */

const MILLI = 1000;
const SIGNUP_KEY = "signup";

/** Whether balances are enforced and shown: `SIGNUP_CREDITS` is set. */
export function creditsEnforced(): boolean {
  return getEnv().SIGNUP_CREDITS !== undefined;
}

/** Whether a reading on this key is charged to the user's credits. */
export function chargesCredits(keySource: AiKeySource | null): boolean {
  return keySource !== null && keySource !== "user";
}

/**
 * Serialises one user's starts, so two at once can't both spend the same credits. `NO KEY UPDATE`
 * and not `UPDATE`: the worker inserts a ledger row while it holds the run's document, and that
 * insert's foreign key only needs a key-share lock on the user, which this doesn't block.
 */
export async function lockUser(tx: Db, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE`;
}

/**
 * How long a queued or running reading holds its estimate. Longer than any real backlog — a
 * template-wide batch on a low rate limit can wait a day — and short enough that a run left QUEUED by
 * a lost job nobody polled again doesn't hold someone's credits for good.
 */
const HOLD_DAYS = 3;

export type CreditPosition = { balance: number; reserved: number; available: number };

/**
 * Thousandths of a credit. Call under `lockUser` when the answer decides a write.
 *
 * The free credits every account starts with are given here, on first look, not at sign-up: one
 * place covers both ways of creating an account and every account older than this. The unique
 * `(userId, onceKey)` makes giving them twice impossible; the insert is only attempted for an
 * account that doesn't have them yet, so the usual call is the one read.
 */
export async function creditPosition(db: Db, userId: string): Promise<CreditPosition> {
  const read = () => db.$queryRaw<{ balance: number; reserved: number; granted: boolean }[]>`
    SELECT
      (SELECT coalesce(sum(e."milliCredits"), 0)::float8 FROM "CreditEntry" e WHERE e."userId" = ${userId}) AS balance,
      EXISTS (SELECT 1 FROM "CreditEntry" e WHERE e."userId" = ${userId} AND e."onceKey" = ${SIGNUP_KEY}) AS granted,
      (
        (SELECT coalesce(sum(r."reservedMilliCredits"), 0)::float8
           FROM "ExtractionRun" r
           JOIN "Document" d ON d.id = r."documentId"
           JOIN "Book" b ON b.id = d."bookId"
          WHERE b."userId" = ${userId} AND r.state IN ('QUEUED', 'RUNNING') AND r."createdAt" > now() - ${HOLD_DAYS} * interval '1 day')
        +
        (SELECT coalesce(sum(p."reservedMilliCredits"), 0)::float8
           FROM "FieldProposal" p
           JOIN "Template" t ON t.id = p."templateId"
           JOIN "Book" b ON b.id = t."bookId"
          WHERE b."userId" = ${userId} AND p.state IN ('QUEUED', 'RUNNING') AND p."createdAt" > now() - ${HOLD_DAYS} * interval '1 day')
      ) AS reserved`;
  let [row] = await read();
  const free = getEnv().SIGNUP_CREDITS;
  if (free !== undefined && row && !row.granted) {
    await db.creditEntry.createMany({
      data: [{ userId, kind: "SIGNUP", milliCredits: free * MILLI, onceKey: SIGNUP_KEY }],
      skipDuplicates: true,
    });
    [row] = await read();
  }
  const balance = row?.balance ?? 0;
  const reserved = row?.reserved ?? 0;
  return { balance, reserved, available: balance - reserved };
}

/** Today's readings (UTC) on the deployment's key, every user's, plus everything being held right now. */
async function dailyUsed(db: Db): Promise<number> {
  const [row] = await db.$queryRaw<{ used: number }[]>`
    SELECT (
      (SELECT coalesce(-sum(e."milliCredits"), 0)::float8 FROM "CreditEntry" e
        WHERE e.kind = 'USAGE' AND e."createdAt" >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      + (SELECT coalesce(sum(r."reservedMilliCredits"), 0)::float8 FROM "ExtractionRun" r
          WHERE r.state IN ('QUEUED', 'RUNNING') AND r."createdAt" > now() - ${HOLD_DAYS} * interval '1 day')
      + (SELECT coalesce(sum(p."reservedMilliCredits"), 0)::float8 FROM "FieldProposal" p
          WHERE p.state IN ('QUEUED', 'RUNNING') AND p."createdAt" > now() - ${HOLD_DAYS} * interval '1 day')
    ) AS used`;
  return row?.used ?? 0;
}

/** One lock for the whole deployment: everyone's starts take turns at the daily ceiling. */
const DAILY_CAP_LOCK = 22_001;

/**
 * Whether a reading estimated at `estimate` may start for this user, and what they have.
 *
 * `gate: true` is for the transaction that writes the holds, after `lockUser`: it takes the daily
 * ceiling's lock, so two users starting at once can't both fit under the same last few credits, and
 * it is the only call that logs a ceiling reached. Without it this is a look — for an estimate, or
 * to refuse a whole selection before any transaction — and takes and logs nothing.
 */
export async function checkStart(
  db: Db,
  userId: string,
  estimate: number,
  opts: { gate: boolean } = { gate: false },
): Promise<{ decision: StartDecision; position: CreditPosition | null }> {
  const cap = getEnv().DAILY_CREDIT_CAP;
  const position = creditsEnforced() ? await creditPosition(db, userId) : null;
  // Always after the user's lock, so the two are never taken in opposite orders.
  if (opts.gate && cap !== undefined) await db.$executeRaw`SELECT pg_advisory_xact_lock(${DAILY_CAP_LOCK})`;
  const decision = decideStart({
    estimate,
    available: position?.available ?? null,
    dailyUsed: cap === undefined ? 0 : await dailyUsed(db),
    dailyCap: cap === undefined ? null : cap * MILLI,
  });
  if (opts.gate && !decision.ok && decision.reason === "daily") {
    log.error("daily credit cap reached: readings are being refused until tomorrow (UTC)", undefined, { userId, cap });
  }
  return { decision, position };
}

export const OUT_OF_CREDITS_MESSAGE = "You've run out of credits, so these pages weren't read. Nothing was charged for them. Ask for more on your account page, then retry.";
export const OUT_OF_CREDITS_PROPOSAL_MESSAGE = "You've run out of credits, so this page wasn't read. Nothing was charged for it. Ask for more on your account page, then try again.";

/**
 * Whether this user's balance has gone below zero. Asked by the worker before each reading it is
 * about to pay for: a start holds an estimate, a reading is charged what it really cost, and a batch
 * whose pages cost more than estimated must stop when the credits are gone rather than at its end.
 * The balance alone, not what is held — a hold is this very batch.
 */
export async function outOfCredits(userId: string, keySource: AiKeySource): Promise<boolean> {
  if (!creditsEnforced() || !chargesCredits(keySource)) return false;
  const total = await prisma.creditEntry.aggregate({ where: { userId }, _sum: { milliCredits: true } });
  return (total._sum.milliCredits ?? 0) < 0;
}

/** For an estimate: what this would use and what there is. Null where credits aren't in play. */
export async function creditEstimate(userId: string, keySource: AiKeySource | null, estimate: number): Promise<CreditEstimate | null> {
  if (!creditsEnforced() || !chargesCredits(keySource)) return null;
  const { decision, position } = await checkStart(prisma, userId, estimate);
  return { estimate, available: position?.available ?? 0, problem: decision.ok ? null : decision.message };
}

type Reading = { userId: string; model: string; inputTokens: number; outputTokens: number; pages: number };

async function charge(tx: Db, reading: Reading, ref: { runId: string } | { proposalId: string }): Promise<void> {
  const cost = costMicroUsd(reading);
  await tx.creditEntry.createMany({
    data: [
      {
        userId: reading.userId,
        kind: "USAGE",
        milliCredits: -toMilliCredits(cost),
        costMicroUsd: cost,
        inputTokens: reading.inputTokens,
        outputTokens: reading.outputTokens,
        model: reading.model,
        pages: reading.pages,
        ...ref,
      },
    ],
    // A run or proposal is charged once, whatever retries its completion.
    skipDuplicates: true,
  });
}

/** Charges a completed extraction run what it really cost. Call in the transaction that completes it. */
export function chargeRun(tx: Db, runId: string, reading: Reading): Promise<void> {
  return charge(tx, reading, { runId });
}

export function chargeProposal(tx: Db, proposalId: string, reading: Reading): Promise<void> {
  return charge(tx, reading, { proposalId });
}

/** What one completed run was charged, in thousandths of a credit; null when it wasn't (a personal key, or before Phase 22). */
export async function runCharge(runId: string): Promise<number | null> {
  const entry = await prisma.creditEntry.findUnique({ where: { runId }, select: { milliCredits: true } });
  return entry ? -entry.milliCredits : null;
}

// ---------- account ----------

export type CreditEntryView = {
  id: string;
  kind: CreditKind;
  milliCredits: number;
  pages: number | null;
  note: string | null;
  createdAt: string;
};

export type CreditAccount = {
  balance: number;
  /** Held by readings that are queued or running. */
  reserved: number;
  /** Everything completed readings have used. */
  used: number;
  /** Pages the balance is worth at what this user's own pages have cost; null until they have read some. */
  pagesLeft: number | null;
  /** Whether `Request more` has anywhere to go. */
  canRequest: boolean;
  entries: CreditEntryView[];
  nextCursor: string | null;
};

const ENTRY_PAGE = 20;

/** The account page's credits section; null where credits aren't enforced, and the section isn't shown. */
export async function creditAccount(userId: string, cursor?: string): Promise<CreditAccount | null> {
  const uid = requireUserId(userId);
  if (!creditsEnforced()) return null;
  const position = await creditPosition(prisma, uid);
  const [usage, rows] = await Promise.all([
    prisma.creditEntry.aggregate({ where: { userId: uid, kind: "USAGE" }, _sum: { milliCredits: true, pages: true } }),
    prisma.creditEntry.findMany({
      where: { userId: uid },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ENTRY_PAGE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, kind: true, milliCredits: true, pages: true, note: true, createdAt: true },
    }),
  ]);
  const used = -(usage._sum.milliCredits ?? 0);
  const pages = usage._sum.pages ?? 0;
  const perPage = pages > 0 && used > 0 ? used / pages : null;
  const page = rows.slice(0, ENTRY_PAGE);
  return {
    balance: position.balance,
    reserved: position.reserved,
    used,
    pagesLeft: perPage === null ? null : Math.max(0, Math.floor(position.available / perPage)),
    canRequest: getEnv().CREDIT_REQUEST_TO !== undefined,
    entries: page.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
    nextCursor: rows.length > ENTRY_PAGE ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/**
 * `Request more`: tells whoever runs SaaKuu, by email, who is asking and where their balance stands.
 * Nothing is granted here. Until credits are sold, each request is also the evidence of who would buy.
 */
export async function requestCredits(userId: string, note: string | undefined): Promise<{ sent: true }> {
  const uid = requireUserId(userId);
  const to = getEnv().CREDIT_REQUEST_TO;
  if (!creditsEnforced() || to === undefined) throw new AppError("VALIDATION", "Requests for more credits aren't set up on this server yet.");
  const [user, position, usage] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: uid }, select: { email: true } }),
    creditPosition(prisma, uid),
    prisma.creditEntry.aggregate({ where: { userId: uid, kind: "USAGE" }, _sum: { milliCredits: true } }),
  ]);
  await getEmailSender().send(
    creditRequestMessage(to, {
      email: user.email,
      balance: creditCount(position.balance),
      used: creditCount(-(usage._sum.milliCredits ?? 0)),
      note: note || null,
    }),
  );
  log.info("credit request sent", { userId: uid });
  return { sent: true };
}
