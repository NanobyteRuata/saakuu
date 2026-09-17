import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { reorderRowSchema } from "@/lib/table/schemas";
import { reorderRow } from "@/lib/table/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ rowId, afterRowId }`: moves one row in manual order; writes exactly that row. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return reorderRow(userId, parseInput(reorderRowSchema, await request.json().catch(() => null)));
  });
  return resultResponse(result);
}
