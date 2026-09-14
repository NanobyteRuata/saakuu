import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Credentials auth end to end. Requires the app to run with EMAIL_TRANSPORT=test so emailed
 * links can be read from /api/test/outbox. Google sign-in is verified manually (see README).
 */

const FIRST_PASSWORD = "firstPass123";
const NEW_PASSWORD = "secondPass456";

function uniqueEmail(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Polls the test outbox for the newest email to `to` containing a `path?token=` link. */
async function tokenFromEmail(request: APIRequestContext, to: string, path: "/verify" | "/reset", notToken?: string) {
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

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("register, verify, reset password and sign out through the confirmation modal", async ({ page, request }) => {
  const email = uniqueEmail();

  // Route protection.
  await page.goto("/books");
  await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Fbooks/);

  // Register.
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(FIRST_PASSWORD);
  await expect(page.getByText("At least one number")).toBeVisible();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  // Unverified accounts cannot sign in.
  await signIn(page, email, FIRST_PASSWORD);
  await expect(page.getByText("Confirm your email address before signing in")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in/);

  // Verify.
  const verifyToken = await tokenFromEmail(request, email, "/verify");
  await page.goto(`/verify?token=${verifyToken}`);
  await page.getByRole("button", { name: "Confirm email" }).click();
  await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();

  // The link is single use.
  await page.goto(`/verify?token=${verifyToken}`);
  await page.getByRole("button", { name: "Confirm email" }).click();
  await expect(page.getByText("This link is invalid or has expired")).toBeVisible();

  // Sign in lands in the app shell.
  await signIn(page, email, FIRST_PASSWORD);
  await expect(page).toHaveURL(/\/books$/);
  await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();
  await expect(page.getByRole("link", { name: "SaaKuu" })).toBeVisible();

  // Registering the same (now verified) address again reveals nothing and changes nothing.
  const again = await request.post("/api/auth/register", { data: { email, password: "otherPass789" } });
  expect(await again.json()).toEqual({ ok: true, data: { emailSent: true } });

  // Forgot + reset.
  await page.goto("/forgot");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const resetToken = await tokenFromEmail(request, email, "/reset");
  await page.goto(`/reset?token=${resetToken}`);
  await page.getByLabel("New password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page).toHaveURL(/\/sign-in\?notice=reset/);
  await expect(page.getByText("Your password has been changed")).toBeVisible();

  // Reset signed out every session, even though the browser still holds the old cookie.
  await page.goto("/books");
  await expect(page).toHaveURL(/\/sign-in/);

  // Old password no longer works; the other registration attempt didn't change it either.
  await signIn(page, email, FIRST_PASSWORD);
  await expect(page.getByText("That email and password don't match an account.")).toBeVisible();
  await signIn(page, email, "otherPass789");
  await expect(page.getByText("That email and password don't match an account.")).toBeVisible();
  await signIn(page, email, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/books$/);

  // Sign out: cancel keeps the session.
  await page.getByRole("button", { name: "Account menu" }).click();
  await expect(page.getByRole("menu").getByText(email)).toBeVisible();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Sign out of SaaKuu?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page).toHaveURL(/\/books$/);

  // Sign out: confirm ends the session.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.goto("/books");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("rejects unsafe callback URLs after sign-in", async ({ page }) => {
  await page.goto("/sign-in?callbackUrl=https://evil.example.com/");
  await expect(page.locator('input[name="callbackUrl"]')).toHaveValue("/books");
});
