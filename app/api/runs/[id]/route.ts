import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { getRun } from "@/lib/extraction/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Run detail including the raw model response, for debugging. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const id = parseInput(idSchema, (await params).id);
    return getRun(userId, id);
  });
  return resultResponse(result);
}
