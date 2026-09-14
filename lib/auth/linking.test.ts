import { describe, expect, it } from "vitest";

import { decideGoogleSignIn } from "./linking";

describe("decideGoogleSignIn", () => {
  it("rejects an email Google has not verified", () => {
    expect(decideGoogleSignIn({ googleEmailVerified: false, existingUser: null })).toEqual({
      kind: "reject",
      reason: "GoogleEmailUnverified",
    });
  });

  it("allows a brand-new user", () => {
    expect(decideGoogleSignIn({ googleEmailVerified: true, existingUser: null })).toEqual({ kind: "allow" });
  });

  it("allows linking to an existing verified account", () => {
    expect(
      decideGoogleSignIn({ googleEmailVerified: true, existingUser: { emailVerified: new Date() } }),
    ).toEqual({ kind: "allow" });
  });

  it("blocks linking to an unverified password account", () => {
    expect(decideGoogleSignIn({ googleEmailVerified: true, existingUser: { emailVerified: null } })).toEqual({
      kind: "reject",
      reason: "VerifyEmailFirst",
    });
  });
});
