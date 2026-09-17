import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { getRetransformStatus, requestRetransform } from "@/lib/mappings/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Poll: `{ state: idle | queued | running, done, total }`. */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    return getRetransformStatus(userId, templateId);
  });
  return resultResponse(result);
}

/** Queues a rebuild of every extracted document's rows from the raw layer. No AI cost. */
export async function POST(_request: Request, { params }: Context): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    return requestRetransform(userId, templateId);
  });
  return resultResponse(result, 202);
}
