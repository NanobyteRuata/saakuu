import { afterEach, describe, expect, it, vi } from "vitest";

import { clientIp } from "./request-ip";

const hops = vi.hoisted(() => ({ value: 1 }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ TRUSTED_PROXY_HOPS: hops.value }) }));

const h = (entries: Record<string, string>) => new Headers(entries);

describe("clientIp: rate limits key on an address the client can't choose", () => {
  afterEach(() => {
    hops.value = 1;
  });

  it("ignores addresses the client prepended behind one appending proxy", () => {
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(h({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("counts trusted hops from the right", () => {
    hops.value = 2;
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 1.2.3.4, 10.0.0.2" }))).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip, then unknown", () => {
    expect(clientIp(h({ "x-real-ip": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(h({}))).toBe("unknown");
  });
});
