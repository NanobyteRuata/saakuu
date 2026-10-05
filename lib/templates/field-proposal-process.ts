import { Prisma } from "@prisma/client";

import { getProvider } from "@/lib/ai";
import { keyMaterial, resolveAiKey } from "@/lib/ai/keys";
import { modelIdSchema } from "@/lib/ai/models";
import { isServerKeyFailure, ProviderError, providerErrorMessage, type ResponseLog } from "@/lib/ai/provider";
import { sortByPosition } from "@/lib/books/column-ops";
import { prisma } from "@/lib/db/client";
import { loadImages, RetryLater, RunFailure } from "@/lib/extraction/process";
import { log } from "@/lib/log";

import { STALE_RUNNING_MS } from "./field-proposals";

/**
 * Worker side of a template proposal (Phase 16). Claims the proposal, reads its pages with the book
 * owner's key, and stores the validated field list. It never touches the template: accepting is the
 * operator's action, not the worker's.
 */

/** Plain-language messages for a proposal. The extraction wording talks about "these pages" and "this template". */
function failureMessage(err: ProviderError, keySource: "user" | "server" | "fake"): string {
  if (err.kind === "INVALID_RESPONSE") return "The AI's answer wasn't a usable field list, even after asking it again. Try again or try the other model.";
  if (err.kind === "RATE_LIMITED") return "The AI service is limiting how fast pages can be sent. Try again in a few minutes.";
  if (err.kind === "UNAVAILABLE") return "The AI service didn't respond. Try again.";
  return providerErrorMessage(err, keySource);
}

function responsesJson(responses: ResponseLog[] | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!responses || responses.length === 0) return Prisma.DbNull;
  return { responses: responses.map((r) => ({ attempt: r.attempt, text: r.text, issues: r.issues })) };
}

export type ProposalOutcome = "gone" | "idle" | "complete" | "failed";

export async function processFieldProposal(proposalId: string, opts: { isLastAttempt: boolean }): Promise<ProposalOutcome> {
  // Millisecond precision, matching the column, so the fencing token compares equal when written back.
  const claimedAt = new Date();
  const { count } = await prisma.fieldProposal.updateMany({
    where: {
      id: proposalId,
      OR: [{ state: "QUEUED" }, { state: "RUNNING", startedAt: { lt: new Date(claimedAt.getTime() - STALE_RUNNING_MS) } }],
    },
    data: { state: "RUNNING", startedAt: claimedAt },
  });
  if (count === 0) return "idle";

  const fence = { id: proposalId, state: "RUNNING" as const, startedAt: claimedAt };
  const fail = async (error: string, extra: { usage?: { inputTokens: number; outputTokens: number }; responses?: ResponseLog[] } = {}) => {
    await prisma.fieldProposal.updateMany({
      where: fence,
      data: {
        state: "FAILED",
        finishedAt: new Date(),
        error,
        inputTokens: extra.usage?.inputTokens ?? null,
        outputTokens: extra.usage?.outputTokens ?? null,
        rawResponse: responsesJson(extra.responses),
      },
    });
  };

  const proposal = await prisma.fieldProposal.findUniqueOrThrow({
    where: { id: proposalId },
    select: {
      model: true,
      photoIds: true,
      documentId: true,
      document: { select: { deletedAt: true } },
      template: {
        select: {
          kind: true,
          languageHint: true,
          instructions: true,
          deletedAt: true,
          // Phase 12: the book's owner pays, however the proposal was started.
          book: { select: { id: true, userId: true, deletedAt: true } },
        },
      },
    },
  });
  const { template } = proposal;
  if (proposal.document.deletedAt !== null || template.deletedAt !== null || template.book.deletedAt !== null) {
    await fail("The page or its template was deleted before it was read.");
    return "gone";
  }

  const aiKey = await resolveAiKey(template.book.userId);
  if (aiKey.source === "none") {
    await fail(aiKey.message);
    return "failed";
  }
  const keySource = aiKey.source;

  try {
    const model = modelIdSchema.safeParse(proposal.model);
    if (!model.success) throw new RunFailure("The model chosen for this proposal is no longer available. Try again.");
    // Its failures are worded for extraction ("Extract it again"); say the same things about a proposal.
    const images = await loadImages(template.book.id, proposal.documentId, proposal.photoIds).catch((err: unknown) => {
      if (err instanceof RunFailure && err.reason === "pages-changed") {
        throw new RunFailure("This page changed while it was being read. Try again in a moment.");
      }
      if (err instanceof RunFailure && err.reason === "too-large") {
        throw new RunFailure("This page is too large to send (over 15 MB). Crop it or remove a photo, then try again.");
      }
      throw err;
    });
    const glossary = await prisma.glossaryEntry.findMany({
      where: { bookId: template.book.id },
      select: { id: true, term: true, meaning: true, position: true },
      take: 500,
    });
    const result = await getProvider(keyMaterial(aiKey)).proposeFields({
      images,
      kind: template.kind,
      languageHint: template.languageHint,
      instructions: template.instructions,
      glossary: sortByPosition(glossary).map((g) => ({ term: g.term, meaning: g.meaning })),
      model: model.data,
    });
    const { count: written } = await prisma.fieldProposal.updateMany({
      where: fence,
      data: {
        state: "COMPLETE",
        finishedAt: new Date(),
        error: null,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        rawResponse: responsesJson(result.rawResponse.responses),
        items: result.fields,
      },
    });
    return written > 0 ? "complete" : "idle";
  } catch (err) {
    if (err instanceof RunFailure) {
      await fail(err.message);
      return "failed";
    }
    if (err instanceof ProviderError) {
      if (err.transient && !opts.isLastAttempt) {
        await prisma.fieldProposal.updateMany({ where: fence, data: { state: "QUEUED", startedAt: null } });
        throw new RetryLater(err.kind === "RATE_LIMITED", err);
      }
      if (isServerKeyFailure(err, keySource)) {
        log.error("server AI key is missing or refused: nothing can be read until it is fixed", err, { proposalId, kind: err.kind });
      } else if (err.kind !== "INVALID_RESPONSE") {
        log.warn("field proposal provider error", { proposalId, kind: err.kind, error: err.message });
      }
      await fail(failureMessage(err, keySource), { usage: err.usage, responses: err.rawResponse?.responses });
      return "failed";
    }
    if (!opts.isLastAttempt) {
      log.error("field proposal attempt failed", err, { proposalId });
      await prisma.fieldProposal.updateMany({ where: fence, data: { state: "QUEUED", startedAt: null } });
      throw new RetryLater(false, err);
    }
    log.error("field proposal failed", err, { proposalId });
    await fail("Something went wrong while reading this page. Try again; if it keeps failing, check the photo is readable.");
    return "failed";
  }
}
