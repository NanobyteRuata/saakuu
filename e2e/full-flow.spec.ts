import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { createVerifiedUser } from "./helpers";

/**
 * Phase 9 acceptance: the whole product path in one run, without touching Gemini.
 * Needs the app with EMAIL_TRANSPORT=test and a worker with AI_PROVIDER=fake (see README → Checks).
 * The fake provider answers "<field label> 1" for each Extract field of a form.
 */

const FIXTURE = path.join(__dirname, "fixtures", "form.jpg");

test("sign in → book → template → upload → extract → review → export", async ({ page }) => {
  test.setTimeout(180_000);
  await createVerifiedUser(page);

  // Book with two output columns.
  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("E2E ledger");
  await page.getByRole("button", { name: "Next: columns" }).click();
  await page.getByLabel("Column 1 label").fill("Name");
  await page.getByRole("button", { name: "Add column" }).click();
  await page.getByLabel("Column 2 label").fill("Village");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}$/);
  const bookUrl = new URL(page.url()).pathname;
  const sections = page.getByRole("navigation", { name: "Book sections" });

  // Form template with two fields (new fields default to Extract).
  await sections.getByRole("link", { name: "Templates" }).click();
  await page.getByRole("button", { name: "Create your first template" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Template name").fill("Household card");
  await createDialog.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}$/);
  const newField = page.getByLabel("New field label, as written on the paper");
  for (const label of ["Name", "Village"]) {
    await newField.fill(label);
    await page.getByRole("button", { name: "Add field" }).click();
    await expect(page.getByRole("list", { name: "Fields and groups in paper order" }).getByText(label, { exact: true })).toBeVisible();
  }

  // Map each column from the field of the same name.
  await page.getByRole("tab", { name: "Mapping" }).click();
  for (const column of ["Name", "Village"]) {
    const row = page.getByRole("listitem").filter({ has: page.getByText(column, { exact: true }) }).filter({ has: page.getByRole("button", { name: "Map" }) });
    await row.getByRole("button", { name: "Map" }).click();
    const editor = page.getByRole("form", { name: `Mapping for ${column}` });
    await editor.getByLabel("Reads").click();
    await page.getByRole("option", { name: new RegExp(`^${column}`) }).click();
    await editor.getByRole("button", { name: "Save mapping" }).click();
    await expect(page.getByText(`Saved the mapping for “${column}”`)).toBeVisible();
  }

  // Upload one photo. Ingestion lives on the Documents tab (Phase 9.1); the only template is pre-selected.
  await page.goto(`${bookUrl}/documents`);
  await page.getByRole("button", { name: "Upload documents" }).click();
  const upload = page.getByRole("dialog", { name: "Upload documents" });
  await upload.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(upload.getByText("1 of 1 file uploaded")).toBeVisible({ timeout: 30_000 });
  await expect(upload.getByRole("button", { name: "Done" })).toBeEnabled({ timeout: 30_000 });
  await upload.getByRole("button", { name: "Done" }).click();

  // The upload produced one document: a header row and one data row.
  await expect(page.getByRole("row")).toHaveCount(2);

  // The list only polls while a run is active, so reload until the photo has finished processing.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("row")).toHaveCount(2);
    await expect(page.getByText("1 page processing")).toBeHidden({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  // Extract the selection. The click is retried: under `next dev` the page can still be hydrating.
  const extractDialog = page.getByRole("alertdialog", { name: "Extract with AI" });
  await expect(async () => {
    if (!(await extractDialog.isVisible())) {
      await page.getByRole("checkbox", { name: "Select all loaded documents" }).check();
      await page.getByRole("button", { name: "Extract", exact: true }).click();
    }
    await expect(extractDialog.getByRole("button", { name: "Extract 1 document" })).toBeEnabled({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await extractDialog.getByRole("button", { name: "Extract 1 document" }).click();
  await expect(extractDialog).toBeHidden();

  await page.goto(bookUrl);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Name 1")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 90_000 });
  await expect(page.getByText("Village 1")).toBeVisible();

  // Review with the keyboard only: Ctrl+Enter marks the row reviewed.
  await page.getByRole("link", { name: "Review rows" }).click();
  const review = page.getByRole("application", { name: "Row review" });
  await expect(review.getByText("Name 1")).toBeVisible();
  await review.focus();
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("Every cell is reviewed")).toBeVisible();

  // Export: BOM, header in column order, the extracted values.
  await page.getByRole("button", { name: "Export CSV" }).first().click();
  const exportDialog = page.getByRole("dialog", { name: "Export CSV" });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    exportDialog.getByRole("button", { name: "Export 1 row" }).click(),
  ]);
  const file = await download.path();
  const bytes = await readFile(file);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = bytes.subarray(3).toString("utf8").trim().split(/\r?\n/);
  expect(lines[0]).toBe("name,village");
  expect(lines[1]).toBe("Name 1,Village 1");
});

