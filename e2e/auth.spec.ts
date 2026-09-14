import { expect, test } from "@playwright/test";

import { signIn, tokenFromEmail, uniqueEmail } from "./helpers";

/**
 * Credentials auth end to end. Requires the app to run with EMAIL_TRANSPORT=test so emailed
 * links can be read from /api/test/outbox. Google sign-in is verified manually (see README).
 */

const FIRST_PASSWORD = "firstPass123";
const NEW_PASSWORD = "secondPass456";

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
  // One hidden input per sign-in form (two when Google is configured); every one must be sanitised.
  const inputs = await page.locator('input[name="callbackUrl"]').all();
  expect(inputs.length).toBeGreaterThan(0);
  for (const input of inputs) await expect(input).toHaveValue("/books");
});
