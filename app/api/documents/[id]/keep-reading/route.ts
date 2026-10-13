import { requireSessionUserId } from "@/lib/auth/session";
import { keepReading } from "@/lib/documents/reading-changes";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Keep this reading: the document counts as read with the fields as they are now. Reads nothing. */
export async function POST(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const documentId = parseInput(idSchema, (await params).id);
    return keepReading(userId, documentId);
  });
  return resultResponse(result);
}
