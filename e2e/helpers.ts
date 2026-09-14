import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Shared E2E helpers. Flows that read emailed links need the app running with
 * EMAIL_TRANSPORT=test so they can be fetched from /api/test/outbox.
 */

export function uniqueEmail(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Polls the test outbox for the newest email to `to` containing a `path?token=` link. */
export async function tokenFromEmail(request: APIRequestContext, to: string, path: "/verify" | "/reset", notToken?: string) {
  const pattern = new RegExp(`${path}\\?token=([\\w-]+)`);
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await request.get(`/api/test/outbox?to=${encodeURIComponent(to)}`);
    expect(res.status(), "outbox unavailable: run the app with EMAIL_TRANSPORT=test").toBe(200);
    const body = (await res.json()) as { message: { text: string } | null };
    const token = body.message?.text.match(pattern)?.[1];
    if (token && token !== notToken) return token;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no ${path} email arrived for ${to}`);
}

export async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** Registers and verifies a fresh account through the API, then signs in through the UI. */
export async function createVerifiedUser(page: Page): Promise<{ email: string; password: string }> {
  const email = uniqueEmail();
  const password = "bookPass123";
  const registered = await page.request.post("/api/auth/register", { data: { email, password } });
  expect(registered.ok()).toBe(true);
  const token = await tokenFromEmail(page.request, email, "/verify");
  const verified = await page.request.post("/api/auth/verify", { data: { token } });
  expect(verified.ok()).toBe(true);
  await signIn(page, email, password);
  await expect(page).toHaveURL(/\/books$/);
  return { email, password };
}
