import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { enforceRateLimits } from "@/lib/rate-limit";
import { estimateSchema } from "@/lib/extraction/schemas";
import { estimateExtraction } from "@/lib/extraction/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    await enforceRateLimits([["extractionEstimate", userId]]);
    const input = parseInput(estimateSchema, await request.json().catch(() => null));
    return estimateExtraction(userId, input);
  });
  return resultResponse(result);
}
