import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { completeUploadSchema } from "@/lib/photos/schemas";
import { completeUpload } from "@/lib/photos/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Creates the document + photo and queues processing; never processes in the request. */
export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(completeUploadSchema, await request.json().catch(() => null));
    return completeUpload(userId, input);
  });
  return resultResponse(result, 201);
}
