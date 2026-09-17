import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { mappingDeleteImpact } from "@/lib/mappings/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Counts for the mapping delete confirmation: cells that empty, and edited cells that keep their value. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const mappingId = parseInput(idSchema, (await params).id);
    return mappingDeleteImpact(userId, mappingId);
  });
  return resultResponse(result);
}
