import { requireSessionUserId } from "@/lib/auth/session";
import { copyBook, bookCopySummary } from "@/lib/books/copy";
import { copyBookSchema } from "@/lib/books/schemas";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** What a new book from this one would carry, for the counted confirmation. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return bookCopySummary(userId, bookId);
  });
  return resultResponse(result);
}

/** Creates a new book with this one's templates, columns, mappings, glossary and rules, and no documents. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const input = parseInput(copyBookSchema, await request.json().catch(() => null));
    return copyBook(userId, bookId, input);
  });
  return resultResponse(result, 201);
}
