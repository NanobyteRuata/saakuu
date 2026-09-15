import { AI_MODELS } from "@/lib/ai/models";
import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await runAction(async () => {
    await requireSessionUserId();
    return AI_MODELS.map((m) => ({ id: m.id, label: m.label, description: m.description, costTier: m.costTier }));
  });
  return resultResponse(result);
}
