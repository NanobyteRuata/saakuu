import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { listDocumentsSchema } from "@/lib/documents/schemas";
import { listDocuments } from "@/lib/documents/service";
import { idSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const input = parseInput(listDocumentsSchema, searchParamsToObject(new URL(request.url).searchParams));
    return listDocuments(userId, bookId, input);
  });
  return resultResponse(result);
}
