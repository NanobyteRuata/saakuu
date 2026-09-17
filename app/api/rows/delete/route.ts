import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { rowsActionSchema } from "@/lib/table/schemas";
import { deleteRows } from "@/lib/table/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ ids, impactHash, confirm }`: deletes rows from the table (soft; rebuilds keep them deleted). */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return deleteRows(userId, parseInput(rowsActionSchema, await request.json().catch(() => null)));
  });
  return resultResponse(result);
}
