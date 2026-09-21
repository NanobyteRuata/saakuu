import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { uploadDaysSchema } from "@/lib/documents/schemas";
import { listUploadDays } from "@/lib/documents/service";
import { idSchema, parseInput, searchParamsToObject } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** The Uploaded filter's options: `?tz=&templateId=` → `[{ day, count }]`, newest day first. */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    const input = parseInput(uploadDaysSchema, searchParamsToObject(new URL(request.url).searchParams));
    return listUploadDays(userId, bookId, input);
  });
  return resultResponse(result);
}
