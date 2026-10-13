import path from "node:path";

import { expect, test } from "@playwright/test";

import { createVerifiedUser } from "./helpers";

/**
 * Phase 27: a field has one of five types, and an age is a Number field whose mapping reads it as an
 * age. Needs the app and the worker with SIGNUP_CREDITS=25, EMAIL_TRANSPORT=test and AI_PROVIDER=fake
 * (see README → Checks). The fake provider answers "<field label> 1", so a field named "37/" reads
 * "37/ 1": not a number, so kept as written, and 37 when read as an age in years.
 */

const FIXTURE = path.join(__dirname, "fixtures", "form.jpg");

test("a Number field is mapped and read as an age", async ({ page }) => {
  test.setTimeout(180_000);
  await createVerifiedUser(page);

  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("E2E five types");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}\/templates$/);
  const bookUrl = new URL(page.url()).pathname.replace(/\/templates$/, "");

  await page.getByRole("button", { name: "Create your first template" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Template name").fill("Age card");
  await createDialog.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}$/);
  const templateUrl = new URL(page.url()).pathname;

  await page.getByRole("button", { name: "Drop photos here, or click to choose them" }).locator("input[type=file]").setInputFiles(FIXTURE);
  await expect(page.getByRole("button", { name: "Propose fields" })).toBeEnabled({ timeout: 60_000 });

  // The type list offers Number, and no longer Whole number, Age or Fraction.
  await page.getByLabel("New field name, as written on the paper").fill("37/");
  await page.getByRole("combobox", { name: "Type for the new field" }).click();
  await expect(page.getByRole("option", { name: "Age" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Whole number" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Fraction" })).toHaveCount(0);
  await page.getByRole("option", { name: "Number", exact: true }).click();
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByRole("list", { name: "Fields in paper order" }).getByText("37/", { exact: true })).toBeVisible();

  // A Number field is mapped as a number: the default for its type.
  await page.goto(`${templateUrl}/mapping`);
  await page.getByRole("button", { name: "Create columns from this template" }).click();
  await page.getByRole("alertdialog", { name: "Creates 1 column and 1 mapping" }).getByRole("button", { name: "Create 1 column" }).click();
  await expect(page.getByText("Filled by this template (1)")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Read 37/ as" })).toHaveText("Number");

  // Read it as an age instead. A new age is in years.
  await page.getByRole("combobox", { name: "Read 37/ as" }).click();
  await page.getByRole("option", { name: "Age" }).click();
  await page.getByRole("button", { name: "Save mapping" }).click();
  await expect(page.getByText(/^Saved the mapping for /)).toBeVisible();

  await page.goto(templateUrl);
  await page.getByRole("button", { name: "Test on this page" }).click();
  await expect(page.getByText("37/ 1")).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Add to documents" }).click();
  const promote = page.getByRole("alertdialog");
  await promote.getByRole("button", { name: "Add to documents" }).click();
  await expect(promote).toBeHidden();

  await page.goto(bookUrl);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("37", { exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText("37/ 1")).toBeHidden();
});
