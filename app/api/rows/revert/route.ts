import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { rowsActionSchema } from "@/lib/table/schemas";
import { revertRows } from "@/lib/table/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ ids, impactHash, confirm }`: reverts the edited cells of the rows to their extracted values. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return revertRows(userId, parseInput(rowsActionSchema, await request.json().catch(() => null)));
  });
  return resultResponse(result);
}
