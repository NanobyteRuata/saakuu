import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { createFieldSchema } from "@/lib/templates/schemas";
import { createField } from "@/lib/templates/structure-service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(createFieldSchema, await request.json().catch(() => null));
    return createField(userId, templateId, input);
  });
  return resultResponse(result, 201);
}
