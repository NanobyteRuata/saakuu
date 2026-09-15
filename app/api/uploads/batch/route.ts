import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { createUploadBatchSchema } from "@/lib/photos/schemas";
import { createUploadBatch } from "@/lib/photos/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** One implicit batch per upload session (docs/02 → Batch). */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(createUploadBatchSchema, await request.json().catch(() => null));
    return createUploadBatch(userId, input.templateId);
  });
  return resultResponse(result, 201);
}
