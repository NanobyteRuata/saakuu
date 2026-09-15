import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { retrySchema } from "@/lib/extraction/schemas";
import { retryExtraction } from "@/lib/extraction/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(retrySchema, await request.json().catch(() => null));
    return retryExtraction(userId, input);
  });
  return resultResponse(result);
}
