import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { reviewCellsSchema } from "@/lib/table/schemas";
import { setCellsReviewed } from "@/lib/table/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ cellIds?, rowIds?, isReviewed }`: marks cells reviewed or not. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return setCellsReviewed(userId, parseInput(reviewCellsSchema, await request.json().catch(() => null)));
  });
  return resultResponse(result);
}
