import { requireSessionUserId } from "@/lib/auth/session";
import { resultResponse, runAction } from "@/lib/errors";
import { enforceRateLimits } from "@/lib/rate-limit";
import { startFieldProposalSchema } from "@/lib/templates/field-proposal-schemas";
import { latestFieldProposal, startFieldProposal } from "@/lib/templates/field-proposals";
import { idSchema, parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** The proposal of this page the dialog should resume (`?documentId=`), or null. */
export async function GET(request: Request, { params }: Params): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    const templateId = parseInput(idSchema, (await params).id);
    const documentId = parseInput(idSchema, new URL(request.url).searchParams.get("documentId"));
    return latestFieldProposal(userId, templateId, documentId);
  });
  return resultResponse(result);
}

/** Starts reading a specimen for fields. Enqueued for the worker; answers with the proposal's id at once. */
export async function POST(request: Request, { params }: Params): Promise<Response> {
  const result = await runAction(async () => {
    const userId = await requireSessionUserId();
    await enforceRateLimits([["fieldProposalStart", userId]]);
    const templateId = parseInput(idSchema, (await params).id);
    const input = parseInput(startFieldProposalSchema, await request.json().catch(() => null));
    return startFieldProposal(userId, templateId, input);
  });
  return resultResponse(result, 202);
}
