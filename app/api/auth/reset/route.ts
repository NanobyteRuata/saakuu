import { resetPasswordSchema } from "@/lib/auth/schemas";
import { resetPassword } from "@/lib/auth/service";
import { resultResponse, runAction } from "@/lib/errors";
import { enforceRateLimits } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request-ip";
import { parseInput } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await runAction(async () => {
    await enforceRateLimits([["tokenIp", clientIp(request.headers)]]);
    const { token, password } = parseInput(resetPasswordSchema, await request.json().catch(() => null));
    return resetPassword(token, password);
  });
  return resultResponse(result);
}
