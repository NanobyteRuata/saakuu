import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { fieldsDeleteImpact } from "@/lib/templates/fields-service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const fieldId = parseInput(idSchema, (await params).id);
    return fieldsDeleteImpact(userId, [fieldId]);
  });
  return resultResponse(result);
}
