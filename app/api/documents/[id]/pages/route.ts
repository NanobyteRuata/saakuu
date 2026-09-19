import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { addPageSchema } from "@/lib/photos/schemas";
import { addPage } from "@/lib/photos/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Adds a page to the end of this document, for a form that was photographed incompletely. */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const documentId = parseInput(idSchema, (await params).id);
    const input = parseInput(addPageSchema, await request.json().catch(() => null));
    return addPage(userId, documentId, input);
  });
  return resultResponse(result, 201);
}
