import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { restoreField } from "@/lib/templates/fields-service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const fieldId = parseInput(idSchema, (await params).id);
    return restoreField(userId, fieldId);
  });
  return resultResponse(result);
}
