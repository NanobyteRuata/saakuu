import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { presignUploadSchema } from "@/lib/photos/schemas";
import { presignUpload } from "@/lib/photos/service";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const input = parseInput(presignUploadSchema, await request.json().catch(() => null));
    return presignUpload(userId, input);
  });
  return resultResponse(result);
}
