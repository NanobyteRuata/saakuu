import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { templatesImpactRequestSchema } from "@/lib/templates/schemas";
import { templatesDeleteImpact } from "@/lib/templates/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(templatesImpactRequestSchema, await request.json().catch(() => null));
    return templatesDeleteImpact(userId, input.ids);
  });
  return resultResponse(result);
}
