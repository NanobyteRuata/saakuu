import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { reviewQueueSchema } from "@/lib/review/schemas";
import { reviewQueue } from "@/lib/review/service";
import { idSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Rows with unreviewed cells in manual order, and the book's review progress: `?cursor=&limit=`. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return reviewQueue(userId, bookId, parseInput(reviewQueueSchema, searchParamsToObject(new URL(request.url).searchParams)));
  });
  return resultResponse(result);
}
