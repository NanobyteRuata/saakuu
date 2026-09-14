/**
 * Google sign-in / account-linking decision (docs/01 §4).
 *
 * Auth.js is configured with `allowDangerousEmailAccountLinking`, so whenever this returns
 * "allow" and a user with the same email exists, the Google account is linked to that user.
 * That is only safe when both sides have proven ownership of the address:
 * - Google must report the email as verified.
 * - An existing password account must have verified its email; otherwise someone could
 *   pre-register a victim's address and inherit their Google sign-in.
 */

export type GoogleSignInDecision =
  | { kind: "allow" }
  | { kind: "reject"; reason: "GoogleEmailUnverified" | "VerifyEmailFirst" };

export function decideGoogleSignIn(input: {
  googleEmailVerified: boolean;
  existingUser: { emailVerified: Date | null } | null;
}): GoogleSignInDecision {
  if (!input.googleEmailVerified) {
    return { kind: "reject", reason: "GoogleEmailUnverified" };
  }
  if (input.existingUser && !input.existingUser.emailVerified) {
    return { kind: "reject", reason: "VerifyEmailFirst" };
  }
  return { kind: "allow" };
}
