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

  // Book with no columns: they are proposed from the template's fields further down (Phase 10).
  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("E2E ledger");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}\/templates$/);
  const bookUrl = new URL(page.url()).pathname.replace(/\/templates$/, "");

  // Form template with two fields (new fields default to Extract).
  await page.getByRole("button", { name: "Create your first template" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Template name").fill("Household card");
  await createDialog.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}$/);
  const templateUrl = new URL(page.url()).pathname;

  // The paper goes on screen first (Phase 15): the page is uploaded as a specimen, in the workspace
  // where the fields are then typed from it.
  await page.getByRole("button", { name: "Drop a photo here, or click to choose one" }).locator("input[type=file]").setInputFiles(FIXTURE);
  await expect(page.getByRole("button", { name: "Read this page" })).toBeEnabled({ timeout: 60_000 });

  const newField = page.getByLabel("New field label, as written on the paper");
  for (const label of ["Name", "Village"]) {
    await newField.fill(label);
    await page.getByRole("button", { name: "Add field" }).click();
    await expect(page.getByRole("list", { name: "Fields and groups in paper order" }).getByText(label, { exact: true })).toBeVisible();
  }

  // Let the app propose the output table: one column and one COPY mapping per unmapped Extract field.
  await page.getByRole("link", { name: "Mapping" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}\/mapping$/);
  await page.getByRole("button", { name: "Create columns from this template" }).click();
  const proposal = page.getByRole("alertdialog", { name: "Creates 2 columns and 2 mappings" });
  await proposal.getByRole("button", { name: "Create 2 columns" }).click();
  await expect(page.getByText("Created 2 columns and 2 mappings")).toBeVisible();
  await expect(page.getByText("Filled by this template (2)")).toBeVisible();

  // Read the specimen where it already is, beside the tree. This is the trust moment, and it is the
  // ordinary extraction of one document (Phase 15).
  await page.goto(templateUrl);
  await page.getByRole("button", { name: "Read this page" }).click();
  await expect(page.getByText("Name 1")).toBeVisible({ timeout: 90_000 });

  // A specimen is out of everything that counts as work: the table has no rows, and the template
  // card counts it apart from its documents (decision 71).
  await page.goto(bookUrl);
  await expect(page.getByText("Name 1")).toBeHidden();
  await page.goto(`${bookUrl}/templates`);
  await expect(page.getByText("0 documents")).toBeVisible();
  await expect(page.getByText("1 specimen")).toBeVisible();

  // Promoting it is a flag flip: the rows were built when it was read, so nothing is extracted again.
  await page.goto(`${bookUrl}/documents`);
  await expect(page.getByText("specimen", { exact: true })).toBeVisible();
  await page.getByRole("row").nth(1).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("button", { name: "Use as a real document" }).click();
  await expect(drawer.getByRole("button", { name: "Use as a real document" })).toBeHidden();
  await page.keyboard.press("Escape");

  // Straight to the table. Nothing in this flow picked a tab, so the landing memory has nothing
  // stored and the book opens where it is asked to (Phase 10).
  await page.goto(bookUrl);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Name 1")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
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

