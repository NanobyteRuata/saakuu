import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";
import { ruleDraftSchema } from "@/lib/validation/rules";
import { deleteRule, updateRule } from "@/lib/validation/rules-service";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; ruleId: string }> };

/** Replaces the rule (the full shape again) and re-checks the affected columns. */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { id, ruleId } = await params;
    const input = parseInput(ruleDraftSchema, await request.json().catch(() => null));
    return updateRule(userId, parseInput(idSchema, id), parseInput(idSchema, ruleId), input);
  });
  return resultResponse(result);
}

export async function DELETE(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { id, ruleId } = await params;
    return deleteRule(userId, parseInput(idSchema, id), parseInput(idSchema, ruleId));
  });
  return resultResponse(result);
}
