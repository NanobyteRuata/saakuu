import { requireSessionUserId } from "@/lib/auth/session";
import { getDocumentRawValues } from "@/lib/documents/service";
import { resultResponse, runAction } from "@/lib/errors";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** What the AI read for this document, before any mapping (docs/05 §6 `Try one document`). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const documentId = parseInput(idSchema, (await params).id);
    return getDocumentRawValues(userId, documentId);
  });
  return resultResponse(result);
}
