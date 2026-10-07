import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { updateFieldSchema } from "@/lib/templates/schemas";
import { updateField } from "@/lib/templates/structure-service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Edit properties and/or move (`move: { after }`). A move writes one row. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const fieldId = parseInput(idSchema, (await params).id);
    const input = parseInput(updateFieldSchema, await request.json().catch(() => null));
    return updateField(userId, fieldId, input);
  });
  return resultResponse(result);
}
