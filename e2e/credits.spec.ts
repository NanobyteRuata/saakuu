import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { createVerifiedUser } from "./helpers";

/**
 * Phase 22: a new account starts with free credits, a reading says what it will use and then what it
 * did use, and a reading that doesn't fit is refused with both numbers before anything is queued.
 * Needs the app and the worker with SIGNUP_CREDITS=25 and CREDIT_REQUEST_TO=owner@example.com, on
 * top of EMAIL_TRANSPORT=test and AI_PROVIDER=fake (see README → Checks).
 */

const FILE = { name: "card.jpg", mimeType: "image/jpeg", buffer: readFileSync(path.join(__dirname, "fixtures", "form.jpg")) };

test("free credits → estimate → exact charge → refusal with both numbers → request more", async ({ page }) => {
  test.setTimeout(180_000);
  const { email } = await createVerifiedUser(page);

  await page.goto("/account");
  const credits = page.getByRole("region", { name: "Credits" });
  await expect(credits.getByText("25.0", { exact: true })).toBeVisible();
  await expect(credits.getByText("Free credits for a new account")).toBeVisible();

  await page.goto("/books");
  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("E2E credits");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}\/templates$/);
  const bookUrl = new URL(page.url()).pathname.replace(/\/templates$/, "");

  await page.getByRole("button", { name: "Create your first template" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Template name").fill("Clinic card");
  await createDialog.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}$/);
  await page.getByLabel("New field name, as written on the paper").fill("Name");
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByRole("list", { name: "Fields in paper order" }).getByText("Name", { exact: true })).toBeVisible();

  await page.goto(`${bookUrl}/documents`);
  await page.getByRole("button", { name: "Upload documents" }).click();
  const uploadDialog = page.getByRole("dialog");
  await uploadDialog.locator("input[type=file]").setInputFiles(FILE);
  await expect(uploadDialog.getByText("1 of 1 file uploaded")).toBeVisible({ timeout: 60_000 });
  await uploadDialog.getByRole("button", { name: "Done" }).click();

  // Before: an estimate, and what there is.
  await page.getByRole("checkbox", { name: "Select all loaded documents" }).check();
  await page.getByRole("button", { name: "Extract", exact: true }).click();
  const extract = page.getByRole("alertdialog");
  await expect(extract.getByText(/About \d+\.\d credits?\. You have 25\.0\./)).toBeVisible();
  await extract.getByRole("button", { name: "Extract 1 document" }).click();

  // After: the exact charge, on the run and on the account. The fake provider reports 258 tokens in
  // and 100 out for one page, which is $0.001287 and so 0.1 credits.
  await page.getByRole("button", { name: /^Runs/ }).click();
  const runs = page.getByRole("dialog", { name: "Extraction runs" });
  await expect(runs.getByRole("list", { name: "Pages" }).getByText("Page 1: Read")).toBeVisible({ timeout: 90_000 });
  await expect(runs.getByText("used 0.1 credits")).toBeVisible();

  await page.goto("/account");
  await expect(credits.getByText("24.9", { exact: true })).toBeVisible();
  await expect(credits.getByRole("row", { name: /Read 1 page/ })).toContainText("−0.1");

  // Out of credits: the dialog says what it needs and what there is, and can't be confirmed.
  const emptied = await page.request.post("/api/test/credits", { data: { email, credits: -25 } });
  expect(emptied.ok()).toBe(true);
  await page.goto(`${bookUrl}/documents`);
  await page.getByRole("checkbox", { name: "Select all loaded documents" }).check();
  await page.getByRole("button", { name: "Extract", exact: true }).click();
  await expect(extract.getByText(/This needs about \d+\.\d credits?\. You have 0\.0\./)).toBeVisible();
  await expect(extract.getByRole("button", { name: "Extract 1 document" })).toBeDisabled();
  await extract.getByRole("link", { name: "See your credits" }).click();

  // Asking for more reaches whoever runs SaaKuu, with the address to grant them to.
  await expect(page).toHaveURL(/\/account/);
  await credits.getByRole("button", { name: "Request more" }).click();
  await credits.getByLabel("What are they for? (optional)").fill("Sixty pages of a register");
  await credits.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("Your request was sent.")).toBeVisible();
  const outbox = await page.request.get(`/api/test/outbox?to=${encodeURIComponent("owner@example.com")}`);
  const body = (await outbox.json()) as { message: { text: string } | null };
  expect(body.message?.text).toContain(`${email} asked for more credits.`);
  expect(body.message?.text).toContain("Sixty pages of a register");
});
