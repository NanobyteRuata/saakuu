import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { exportOptionsSchema } from "@/lib/export/schemas";
import { exportPreview } from "@/lib/export/service";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Export options -> the row count and what is left unreviewed or flagged. Writes nothing. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const bookId = parseInput(idSchema, (await params).id);
    return exportPreview(userId, bookId, parseInput(exportOptionsSchema, await request.json().catch(() => null)));
  });
  return resultResponse(result);
}
