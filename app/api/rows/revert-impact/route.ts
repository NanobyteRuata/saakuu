import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { rowsImpactSchema } from "@/lib/table/schemas";
import { rowsRevertImpact } from "@/lib/table/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ ids }` → counts for the revert confirmation: rows, edited cells, disagreements. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { ids } = parseInput(rowsImpactSchema, await request.json().catch(() => null));
    return rowsRevertImpact(userId, ids);
  });
  return resultResponse(result);
}
