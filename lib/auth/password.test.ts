import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password";

describe("password hashing", () => {
  it("verifies the original password and rejects others", async () => {
    const hash = await hashPassword("correct horse 1");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("correct horse 1");
    await expect(verifyPassword("correct horse 1", hash)).resolves.toBe(true);
    await expect(verifyPassword("correct horse 2", hash)).resolves.toBe(false);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same-pass-9"), hashPassword("same-pass-9")]);
    expect(a).not.toBe(b);
  });

  it("treats malformed hashes as a failed match", async () => {
    for (const bad of ["", "plain", "scrypt$1$2$3", "bcrypt$a$b$c$d$e", "scrypt$x$8$1$c2FsdA$aGFzaA", "scrypt$32768$8$1$c2FsdA$"]) {
      await expect(verifyPassword("anything1", bad)).resolves.toBe(false);
    }
  });
});
