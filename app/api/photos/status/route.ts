import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { photoStatusQuerySchema } from "@/lib/photos/schemas";
import { getPhotoStatuses } from "@/lib/photos/service";
import { parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Poll: `?ids=a,b,c` → current processing state and image URLs. */
export async function GET(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { ids } = parseInput(photoStatusQuerySchema, searchParamsToObject(new URL(request.url).searchParams));
    return getPhotoStatuses(userId, ids);
  });
  return resultResponse(result);
}
