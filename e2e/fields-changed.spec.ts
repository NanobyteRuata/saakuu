import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { createVerifiedUser } from "./helpers";

/**
 * Phase 28: a document read before a field change is flagged, in the list, in the Status filter and on
 * the template, and all three agree. Undoing the change clears them; so does Keep these readings, which
 * reads nothing.
 * Needs the app and the worker with SIGNUP_CREDITS=25, EMAIL_TRANSPORT=test and AI_PROVIDER=fake (see
 * README → Checks).
 */

const FIXTURE = path.join(__dirname, "fixtures", "form.jpg");
const BANNER = "1 of 1 document was read before your latest field changes.";
const CHIP = "fields changed since read";

async function expectBalance(page: Page, balance: string) {
  await page.goto("/account");
  await expect(page.getByRole("region", { name: "Credits" }).getByText(balance, { exact: true })).toBeVisible();
}

/** Sets the note of the one field and waits for the autosave. */
async function setNote(page: Page, templateUrl: string, note: string) {
  await page.goto(templateUrl);
  await page.getByRole("list", { name: "Fields in paper order" }).getByText("Name", { exact: true }).click();
  const form = page.getByRole("form", { name: "Field properties form" });
  await form.getByLabel("Note for the AI").fill(note);
  await form.getByLabel("Note for the AI").blur();
  await expect(form.getByText("All changes saved")).toBeVisible();
}

/** The list chip and both sides of the Status filter say the same thing. The chip is lower case; the filter's own label is not. */
async function expectDocumentFlagged(page: Page, bookUrl: string, flagged: boolean) {
  await page.goto(`${bookUrl}/documents`);
  await expect(page.getByText(CHIP, { exact: true })).toHaveCount(flagged ? 1 : 0);
  await page.goto(`${bookUrl}/documents?status=fields-changed`);
  await expect(page.getByText("No documents match these filters")).toHaveCount(flagged ? 0 : 1);
  await expect(page.getByText(CHIP, { exact: true })).toHaveCount(flagged ? 1 : 0);
  await page.goto(`${bookUrl}/documents?status=fields-unchanged`);
  await expect(page.getByText("No documents match these filters")).toHaveCount(flagged ? 1 : 0);
}

test("a field change flags the documents read before it; undo and Keep clear it", async ({ page }) => {
  test.setTimeout(240_000);
  await createVerifiedUser(page);

  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("E2E fields changed");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}\/templates$/);
  const bookUrl = new URL(page.url()).pathname.replace(/\/templates$/, "");

  await page.getByRole("button", { name: "Create your first template" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Template name").fill("Card");
  await createDialog.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}$/);
  const templateUrl = new URL(page.url()).pathname;

  await page.getByRole("button", { name: "Drop photos here, or click to choose them" }).locator("input[type=file]").setInputFiles(FIXTURE);
  await expect(page.getByRole("button", { name: "Propose fields" })).toBeEnabled({ timeout: 60_000 });
  await page.getByLabel("New field name, as written on the paper").fill("Name");
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByRole("list", { name: "Fields in paper order" }).getByText("Name", { exact: true })).toBeVisible();

  // One reading, the only one in this test, added to the documents with the page.
  await page.getByRole("button", { name: "Test on this page" }).click();
  await expect(page.getByText("Name 1")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Add to documents" }).click();
  const promote = page.getByRole("alertdialog");
  await promote.getByRole("button", { name: "Add to documents" }).click();
  await expect(promote).toBeHidden();
  await expectBalance(page, "24.9");

  // Read with the fields as they are: nothing is flagged.
  await expectDocumentFlagged(page, bookUrl, false);

  // A note is something the AI is told, so changing it flags the document everywhere.
  await setNote(page, templateUrl, "Copy titles too.");
  await expect(page.getByText(BANNER)).toBeVisible();
  await expectDocumentFlagged(page, bookUrl, true);

  // Undone, the AI is told what it was told before: the flag goes by itself.
  await setNote(page, templateUrl, "");
  await expect(page.getByText(BANNER)).toBeHidden();
  await expectDocumentFlagged(page, bookUrl, false);

  // Changed again, and kept.
  await setNote(page, templateUrl, "Copy titles too.");
  await expect(page.getByText(BANNER)).toBeVisible();
  await page.getByRole("button", { name: "Keep these readings" }).click();
  const keep = page.getByRole("alertdialog", { name: "Keep these readings?" });
  await expect(keep.getByText(/keeps the readings of 1 document/)).toBeVisible();
  await keep.getByRole("button", { name: "Keep 1 reading" }).click();
  await expect(keep).toBeHidden();
  await expect(page.getByText(BANNER)).toBeHidden();
  await expectDocumentFlagged(page, bookUrl, false);

  // Nothing was read again: the balance is what the one reading left.
  await expectBalance(page, "24.9");
});
