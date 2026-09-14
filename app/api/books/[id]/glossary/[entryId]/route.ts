import { requireSessionUserId } from "@/lib/auth/session";
import { deleteGlossaryEntry, updateGlossaryEntry } from "@/lib/books/glossary-service";
import { glossaryEntryPatchSchema } from "@/lib/books/schemas";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; entryId: string }> };

async function ids(params: Context["params"]) {
  const { id, entryId } = await params;
  return { bookId: parseInput(idSchema, id), entryId: parseInput(idSchema, entryId) };
}

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { bookId, entryId } = await ids(params);
    const input = parseInput(glossaryEntryPatchSchema, await request.json().catch(() => null));
    return updateGlossaryEntry(userId, bookId, entryId, input);
  });
  return resultResponse(result);
}

export async function DELETE(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { bookId, entryId } = await ids(params);
    return deleteGlossaryEntry(userId, bookId, entryId);
  });
  return resultResponse(result);
}
