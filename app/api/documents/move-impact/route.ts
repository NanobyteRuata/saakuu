import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { moveImpactSchema } from "@/lib/documents/schemas";
import { documentsMoveImpact } from "@/lib/documents/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(moveImpactSchema, await request.json().catch(() => null));
    return documentsMoveImpact(userId, input);
  });
  return resultResponse(result);
}
