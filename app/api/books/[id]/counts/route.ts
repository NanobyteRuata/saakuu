import { requireSessionUserId } from "@/lib/auth/session";
import { getBookCounts } from "@/lib/books/service";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** The workspace nav's counts (docs/04, docs/06 Phase 13). Polled only while a run is active. */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return getBookCounts(userId, bookId);
  });
  return resultResponse(result);
}
