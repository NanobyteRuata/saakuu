import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { updateDocumentSchema } from "@/lib/documents/schemas";
import { getDocument, updateDocument } from "@/lib/documents/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const documentId = parseInput(idSchema, (await params).id);
    return getDocument(userId, documentId);
  });
  return resultResponse(result);
}

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const documentId = parseInput(idSchema, (await params).id);
    const input = parseInput(updateDocumentSchema, await request.json().catch(() => null));
    return updateDocument(userId, documentId, input);
  });
  return resultResponse(result);
}
