import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { moveDocumentsSchema } from "@/lib/documents/schemas";
import { moveDocuments } from "@/lib/documents/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(moveDocumentsSchema, await request.json().catch(() => null));
    return moveDocuments(userId, input);
  });
  return resultResponse(result);
}
