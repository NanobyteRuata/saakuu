import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { promoteImpact } from "@/lib/templates/specimens";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** What adding this specimen to the documents does, for the counted confirmation (decision 78). */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const documentId = parseInput(idSchema, (await params).id);
    return promoteImpact(userId, documentId);
  });
  return resultResponse(result);
}
