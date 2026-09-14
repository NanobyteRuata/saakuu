import { requireSessionUserId } from "@/lib/auth/session";
import { booksDeleteImpact } from "@/lib/books/service";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return booksDeleteImpact(userId, [bookId]);
  });
  return resultResponse(result);
}
