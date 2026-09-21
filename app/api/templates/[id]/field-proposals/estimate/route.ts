import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { enforceRateLimits } from "@/lib/rate-limit";
import { fieldProposalEstimateSchema } from "@/lib/templates/field-proposal-schemas";
import { estimateFieldProposal } from "@/lib/templates/field-proposals";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** What reading this page for fields would cost, and whose key pays, before anything runs (Phase 16). */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    await enforceRateLimits([["extractionEstimate", userId]]);
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(fieldProposalEstimateSchema, await request.json().catch(() => null));
    return estimateFieldProposal(userId, templateId, input);
  });
  return resultResponse(result);
}
