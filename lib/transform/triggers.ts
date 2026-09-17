import { prisma } from "@/lib/db/client";
import { log } from "@/lib/log";
import { discardQueue, enqueueBookRevalidation, enqueueDocumentTransform, enqueueTemplateTransform, QUEUES } from "@/lib/queue";

/**
 * Asks the worker to rebuild rows after something the transform reads has changed (mappings, fields,
 * groups, Manual values, book numeral or era settings). Never throws and never waits long: the change
 * itself is already saved, and "Rebuild rows" on the Mapping tab runs it again if the queue was
 * unreachable.
 */

const ENQUEUE_TIMEOUT_MS = 5000;

async function bestEffort(enqueue: () => Promise<void>, context: Record<string, string>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`queue did not answer within ${ENQUEUE_TIMEOUT_MS} ms`)), ENQUEUE_TIMEOUT_MS);
  });
  try {
    await Promise.race([enqueue(), timeout]);
  } catch (err) {
    log.error("transform enqueue failed", err, context);
    // A half-open connection would make the next request wait too: start the next one on a fresh connection.
    await discardQueue(QUEUES.transform);
  } finally {
    clearTimeout(timer);
  }
}

export async function requestTemplateTransform(templateId: string): Promise<void> {
  await bestEffort(() => enqueueTemplateTransform({ templateId }), { templateId });
}

export async function requestDocumentTransform(documentId: string): Promise<void> {
  await bestEffort(() => enqueueDocumentTransform({ documentId }), { documentId });
}

/** Asks the worker to re-check every cell of a book against its rules (best effort, like a rebuild). */
export async function requestBookRevalidation(bookId: string): Promise<void> {
  await bestEffort(() => enqueueBookRevalidation({ bookId }), { bookId });
}

export async function requestBookTransform(bookId: string): Promise<void> {
  const templates = await prisma.template.findMany({ where: { bookId, deletedAt: null }, select: { id: true }, take: 200 });
  await Promise.all(templates.map((t) => requestTemplateTransform(t.id)));
}
