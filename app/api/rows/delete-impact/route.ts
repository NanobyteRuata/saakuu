import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { rowsImpactSchema } from "@/lib/table/schemas";
import { rowsDeleteImpact } from "@/lib/table/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ ids }` → counts for the delete confirmation: rows, filled cells, edited and reviewed cells. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { ids } = parseInput(rowsImpactSchema, await request.json().catch(() => null));
    return rowsDeleteImpact(userId, ids);
  });
  return resultResponse(result);
}
