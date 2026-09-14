import { requireSessionUserId } from "@/lib/auth/session";
import { createGlossaryEntry, listGlossary } from "@/lib/books/glossary-service";
import { glossaryEntryInputSchema } from "@/lib/books/schemas";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, paginationSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const page = parseInput(paginationSchema, searchParamsToObject(new URL(request.url).searchParams));
    return listGlossary(userId, bookId, page);
  });
  return resultResponse(result);
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const input = parseInput(glossaryEntryInputSchema, await request.json().catch(() => null));
    return createGlossaryEntry(userId, bookId, input);
  });
  return resultResponse(result, 201);
}
