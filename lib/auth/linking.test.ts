import { describe, expect, it } from "vitest";

import { decideGoogleSignIn } from "./linking";

describe("decideGoogleSignIn", () => {
  it("rejects an email Google has not verified", () => {
    expect(decideGoogleSignIn({ googleEmailVerified: false, existingUser: null, signUpAllowed: true })).toEqual({
      kind: "reject",
      reason: "GoogleEmailUnverified",
    });
  });

  it("allows a brand-new user", () => {
    expect(decideGoogleSignIn({ googleEmailVerified: true, existingUser: null, signUpAllowed: true })).toEqual({ kind: "allow" });
  });

  it("allows linking to an existing verified account", () => {
    expect(
      decideGoogleSignIn({ googleEmailVerified: true, existingUser: { emailVerified: new Date() }, signUpAllowed: true }),
    ).toEqual({ kind: "allow" });
  });

  it("blocks linking to an unverified password account", () => {
    expect(decideGoogleSignIn({ googleEmailVerified: true, existingUser: { emailVerified: null }, signUpAllowed: true })).toEqual({
      kind: "reject",
      reason: "VerifyEmailFirst",
    });
  });

  it("turns away a brand-new user who isn't invited", () => {
    expect(decideGoogleSignIn({ googleEmailVerified: true, existingUser: null, signUpAllowed: false })).toEqual({
      kind: "reject",
      reason: "InviteOnly",
    });
  });

  it("never locks out an existing account that is no longer on the list", () => {
    expect(
      decideGoogleSignIn({ googleEmailVerified: true, existingUser: { emailVerified: new Date() }, signUpAllowed: false }),
    ).toEqual({ kind: "allow" });
  });
});
