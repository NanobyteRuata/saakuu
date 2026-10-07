import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { stopFieldProposal } from "@/lib/templates/field-proposals";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; proposalId: string }> };

/** Stops a reading that hasn't finished. Idempotent: stopping a finished one changes nothing and says so. */
export async function POST(_request: Request, { params }: Params): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const { id, proposalId } = await params;
    return stopFieldProposal(userId, parseInput(idSchema, id), parseInput(idSchema, proposalId));
  });
  return resultResponse(result);
}
