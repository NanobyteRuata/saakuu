import { requireSessionUserId } from "@/lib/auth/session";
import { listColumns } from "@/lib/books/columns-service";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Live columns in manual order. Bounded by the per-book column limit, so not paginated. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return listColumns(userId, bookId);
  });
  return resultResponse(result);
}
