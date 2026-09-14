import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { deleteTemplatesSchema } from "@/lib/templates/schemas";
import { deleteTemplates } from "@/lib/templates/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Soft-deletes templates and their documents. Requires `confirm: true` and the preview's `impactHash`. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(deleteTemplatesSchema, await request.json().catch(() => null));
    return deleteTemplates(userId, input);
  });
  return resultResponse(result);
}
