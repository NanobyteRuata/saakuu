import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { documentsImpactSchema } from "@/lib/documents/schemas";
import { documentsDeleteImpact } from "@/lib/documents/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(documentsImpactSchema, await request.json().catch(() => null));
    return documentsDeleteImpact(userId, input.ids);
  });
  return resultResponse(result);
}
