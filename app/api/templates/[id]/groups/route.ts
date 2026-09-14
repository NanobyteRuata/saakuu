import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { createGroupSchema } from "@/lib/templates/schemas";
import { createGroup } from "@/lib/templates/structure-service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Creates a group at the end of its parent (`parentGroupId`, null = top level). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(createGroupSchema, await request.json().catch(() => null));
    return createGroup(userId, templateId, input);
  });
  return resultResponse(result, 201);
}
