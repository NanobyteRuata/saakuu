import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";
import { ruleDraftSchema } from "@/lib/validation/rules";
import { createRule, listRules } from "@/lib/validation/rules-service";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** The book's rules, each with how many cells it flags now. */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    return listRules(userId, parseInput(idSchema, (await params).id));
  });
  return resultResponse(result);
}

/** Creates a rule and re-checks its column's cells before answering. */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return createRule(userId, bookId, parseInput(ruleDraftSchema, await request.json().catch(() => null)));
  });
  return resultResponse(result, 201);
}
