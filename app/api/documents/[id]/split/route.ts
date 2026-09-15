import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { splitDocumentSchema } from "@/lib/documents/schemas";
import { splitDocument } from "@/lib/documents/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const documentId = parseInput(idSchema, (await params).id);
    const input = parseInput(splitDocumentSchema, await request.json().catch(() => null));
    return splitDocument(userId, documentId, input);
  });
  return resultResponse(result, 201);
}
