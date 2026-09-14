import { requireSessionUserId } from "@/lib/auth/session";
import { updateBookSchema } from "@/lib/books/schemas";
import { getBook, updateBook } from "@/lib/books/service";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return getBook(userId, bookId);
  });
  return resultResponse(result);
}

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const input = parseInput(updateBookSchema, await request.json().catch(() => null));
    return updateBook(userId, bookId, input);
  });
  return resultResponse(result);
}
