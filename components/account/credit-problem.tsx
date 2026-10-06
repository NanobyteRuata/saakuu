import Link from "next/link";

import { FormMessage } from "@/components/auth/form-message";
import type { CreditEstimate } from "@/lib/credits/rate";

/**
 * Why a reading can't start for want of credits (Phase 22), with both numbers, and the way to ask for
 * more. Shared by every dialog that starts a reading, so the refusal reads the same wherever it is met.
 */
export function CreditProblem({ credits }: { credits: CreditEstimate | null | undefined }) {
  if (!credits?.problem) return null;
  return (
    <FormMessage tone="error">
      {credits.problem}{" "}
      <Link href="/account#section-credits" className="underline">
        See your credits
      </Link>
    </FormMessage>
  );
}
