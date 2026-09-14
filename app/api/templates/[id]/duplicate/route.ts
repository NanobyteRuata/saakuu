import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { duplicateTemplateSchema } from "@/lib/templates/schemas";
import { duplicateTemplate } from "@/lib/templates/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(duplicateTemplateSchema, await request.json().catch(() => null));
    return duplicateTemplate(userId, templateId, input);
  });
  return resultResponse(result, 201);
}
