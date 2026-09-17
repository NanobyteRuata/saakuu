import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { validateMappings } from "@/lib/mappings/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Re-checks every mapping, stores OK/BROKEN and returns the reasons. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    return validateMappings(userId, templateId);
  });
  return resultResponse(result);
}
