import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { createVerifiedUser } from "./helpers";

/**
 * Phase 26: how a mapping reads a field (Read as) is changed on the Mapping tab, and the cells follow
 * with no new reading and no credit spent.
 * Needs the app and the worker with SIGNUP_CREDITS=25, EMAIL_TRANSPORT=test and AI_PROVIDER=fake (see
 * README → Checks). The fake provider answers "<field label> 1", so a field named "41/" reads "41/ 1":
 * kept as written by default, and 41 when read as a fraction.
 */

const FIXTURE = path.join(__dirname, "fixtures", "form.jpg");

async function expectBalance(page: Page, balance: string) {
  await page.goto("/account");
  await expect(page.getByRole("region", { name: "Credits" }).getByText(balance, { exact: true })).toBeVisible();
}

test("Read as on a mapping changes the cells with no reading", async ({ page }) => {
  test.setTimeout(180_000);
  await createVerifiedUser(page);

  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("E2E read as");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}\/templates$/);
  const bookUrl = new URL(page.url()).pathname.replace(/\/templates$/, "");

  await page.getByRole("button", { name: "Create your first template" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Template name").fill("Dose card");
  await createDialog.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}$/);
  const templateUrl = new URL(page.url()).pathname;

  await page.getByRole("button", { name: "Drop photos here, or click to choose them" }).locator("input[type=file]").setInputFiles(FIXTURE);
  await expect(page.getByRole("button", { name: "Propose fields" })).toBeEnabled({ timeout: 60_000 });
  await page.getByLabel("New field name, as written on the paper").fill("41/");
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByRole("list", { name: "Fields in paper order" }).getByText("41/", { exact: true })).toBeVisible();

  // A Text field is mapped "as written": the default for its type.
  await page.goto(`${templateUrl}/mapping`);
  await page.getByRole("button", { name: "Create columns from this template" }).click();
  await page.getByRole("alertdialog", { name: "Creates 1 column and 1 mapping" }).getByRole("button", { name: "Create 1 column" }).click();
  await expect(page.getByText("Filled by this template (1)")).toBeVisible();

  // One reading, the only one in this test.
  await page.goto(templateUrl);
  await page.getByRole("button", { name: "Test on this page" }).click();
  await expect(page.getByText("41/ 1")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Add to documents" }).click();
  const promote = page.getByRole("alertdialog");
  await promote.getByRole("button", { name: "Add to documents" }).click();
  await expect(promote).toBeHidden();

  await page.goto(bookUrl);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("41/ 1")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expectBalance(page, "24.9");

  // Read the same field as a fraction. The preview shows it before saving; saving rebuilds the rows.
  await page.goto(`${templateUrl}/mapping`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Read 41/ as" }).click();
  await page.getByRole("option", { name: "Fraction" }).click();
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByText(/^Saved the mapping for /)).toBeVisible();

  await page.goto(bookUrl);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("41", { exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText("41/ 1")).toBeHidden();

  // Nothing was read again: the balance is what the one reading left.
  await expectBalance(page, "24.9");

  // And the setting stayed where it was put.
  await page.goto(`${templateUrl}/mapping`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Read 41/ as" })).toHaveText("Fraction");
});
