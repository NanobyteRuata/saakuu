import { getEnv } from "@/lib/env";

/**
 * The invite list (Phase 21, decision 79). Every reading runs on the deployment's own AI key, so the
 * people on this list are the only bound on what that key spends until a quota exists (decision 55).
 *
 * `SIGNUP_ALLOWED_EMAILS` is comma-separated addresses, or `*` for anyone; `lib/env.ts` parses and
 * validates it. Unset also means anyone, which is what local work and the E2E suite run with, and
 * which production refuses to start on. Addresses match exactly after trimming and lowercasing:
 * `a.b+x@gmail.com` is not `ab@gmail.com`, so invite the address the person will actually type.
 *
 * It is asked in two places. **Creating an account** (password registration, a first Google
 * sign-in), and **reading on the server's key** (`resolveAiKey`). Signing in is never gated: someone
 * taken off the list keeps their books, their review and their export, and stops being able to spend.
 */

export const INVITE_ONLY_MESSAGE = "SaaKuu is invite-only for now. Ask for an invitation with this email address.";

/** Whether there is a list at all, for screens that say so before anyone types an address. */
export function inviteOnly(): boolean {
  return typeof getEnv().SIGNUP_ALLOWED_EMAILS === "object";
}

export function isInvited(email: string): boolean {
  const list = getEnv().SIGNUP_ALLOWED_EMAILS;
  return typeof list !== "object" || list.has(email.trim().toLowerCase());
}
