import { requireSessionUserId } from "@/lib/auth/session";
import { readingChanges } from "@/lib/documents/reading-changes";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** How many of this template's documents were read before its latest field changes (decision 88). */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    return readingChanges(userId, templateId);
  });
  return resultResponse(result);
}
