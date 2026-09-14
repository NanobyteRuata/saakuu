import { requireSessionUserId } from "@/lib/auth/session";
import { deleteBooksSchema } from "@/lib/books/schemas";
import { deleteBooks } from "@/lib/books/service";
import { resultResponse, runAction } from "@/lib/errors";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Soft-deletes books. Requires `confirm: true` and the `impactHash` from `/api/books/delete-impact`. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(deleteBooksSchema, await request.json().catch(() => null));
    return deleteBooks(userId, input);
  });
  return resultResponse(result);
}
