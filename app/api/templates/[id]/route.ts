import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { updateTemplateSchema } from "@/lib/templates/schemas";
import { getTemplate, updateTemplate } from "@/lib/templates/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    return getTemplate(userId, templateId);
  });
  return resultResponse(result);
}

/** Template settings. `kind` is refused: switching Form ↔ Table is structural (docs/01 §8). */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(updateTemplateSchema, await request.json().catch(() => null));
    return updateTemplate(userId, templateId, input);
  });
  return resultResponse(result);
}
