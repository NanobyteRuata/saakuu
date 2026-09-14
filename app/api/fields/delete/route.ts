import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { deleteFields } from "@/lib/templates/fields-service";
import { deleteFieldsSchema } from "@/lib/templates/schemas";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Soft-deletes fields (raw values are kept). Requires `confirm: true` and the preview's `impactHash`. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(deleteFieldsSchema, await request.json().catch(() => null));
    return deleteFields(userId, input);
  });
  return resultResponse(result);
}
