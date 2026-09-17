import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { exportOptionsSchema } from "@/lib/export/schemas";
import { createExport } from "@/lib/export/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** `{ includeVoid, includeProvenance, columns?, blankToken?, illegibleToken? }` -> `{ downloadUrl }`, valid for 5 minutes. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return createExport(userId, bookId, parseInput(exportOptionsSchema, await request.json().catch(() => null)));
  });
  return resultResponse(result);
}
