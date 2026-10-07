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
  await page.getByRole("button", { name: "Drop photos here, or click to choose them" }).locator("input[type=file]").setInputFiles(FIXTURE);
  await expect(page.getByRole("button", { name: "Propose fields" })).toBeEnabled({ timeout: 60_000 });

  const newField = page.getByLabel("New field name, as written on the paper");
  for (const label of ["Name", "Village"]) {
    await newField.fill(label);
    await page.getByRole("button", { name: "Add field" }).click();
    await expect(page.getByRole("list", { name: "Fields in paper order" }).getByText(label, { exact: true })).toBeVisible();
  }

  // Let the app propose the output table: one column and one COPY mapping per unmapped Extract field.
  await page.getByRole("link", { name: "Mapping" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}\/mapping$/);
  await page.getByRole("button", { name: "Create columns from this template" }).click();
  const proposal = page.getByRole("alertdialog", { name: "Creates 2 columns and 2 mappings" });
  await proposal.getByRole("button", { name: "Create 2 columns" }).click();
  await expect(page.getByText("Created 2 columns and 2 mappings")).toBeVisible();
  await expect(page.getByText("Filled by this template (2)")).toBeVisible();

  // Read the specimen where it already is, beside the field list. This is the trust moment, and it is the
  // ordinary extraction of one document (Phase 15).
  await page.goto(templateUrl);
  await page.getByRole("button", { name: "Test on this page" }).click();
  await expect(page.getByText("Name 1")).toBeVisible({ timeout: 90_000 });

  // A specimen belongs to its template (decision 78): the table has no rows, and the template card
  // counts it apart from its documents.
  await page.goto(bookUrl);
  await expect(page.getByText("Name 1")).toBeHidden();
  await page.goto(`${bookUrl}/templates`);
  await expect(page.getByText("0 documents")).toBeVisible();
  await expect(page.getByText("1 specimen")).toBeVisible();

  // Adding it to the documents is a copy. The test is current, so its reading travels with it and
  // nothing is read again; the specimen and its reading stay with the template.
  await page.goto(templateUrl);
  await expect(page.getByText("Name 1")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Add to documents" }).click();
  const promote = page.getByRole("alertdialog");
  await expect(promote.getByText(/Nothing is read again\./)).toBeVisible();
  await promote.getByRole("button", { name: "Add to documents" }).click();
  await expect(promote).toBeHidden();
  await expect(page.getByText("Test reading")).toBeVisible();
  await expect(page.getByText("Name 1")).toBeVisible();

  // Documents lists the copy, and only the copy.
  await page.goto(`${bookUrl}/documents`);
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByText("specimen", { exact: true })).toBeHidden();

  // Straight to the table. Nothing in this flow picked a tab, so the landing memory has nothing
  // stored and the book opens where it is asked to (Phase 10).
  await page.goto(bookUrl);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText("Name 1")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText("Village 1")).toBeVisible();

  // Sweep one column down the book, keyboard only, from its header menu (Phase 20): each value beside its own region.
  await page.getByRole("button", { name: /^Village/ }).click();
  await page.getByRole("link", { name: /^Sweep this column/ }).click();
  const sweep = page.getByRole("application", { name: "Column sweep" });
  await expect(sweep.getByRole("option", { selected: true })).toContainText("Village 1");
  await sweep.focus();
  await page.keyboard.press("Enter");
  await expect(sweep.getByText("Every value in Village is reviewed")).toBeVisible();
  await expect(sweep.getByText(/^1 of 1 reviewed in this column · 1 of 2 cells in the book/)).toBeVisible();

  // Then row review, with the keyboard only, picks up at the cell the sweep left: Ctrl+Enter marks the row reviewed.
  await page.getByRole("link", { name: "Review rows" }).click();
  const review = page.getByRole("application", { name: "Row review" });
  await expect(review.getByText("Name 1")).toBeVisible();
  await review.focus();

  // A convention met mid-review goes to the glossary from where it was met (Phase 19): G offers the active value.
  await page.keyboard.press("g");
  const glossary = page.getByRole("dialog", { name: "Add to glossary" });
  await expect(glossary.getByLabel("Term, as written on the paper")).toHaveValue("Name 1");
  await glossary.getByLabel("What it means").fill("A placeholder name the fake provider writes");
  await glossary.getByRole("button", { name: "Add to glossary" }).click();
  await expect(page.getByText("Added “Name 1” to the glossary. The next extraction will use it.")).toBeVisible();

  await review.focus();
  await page.keyboard.press("Control+Enter");
  await expect(page.getByText("Every cell is reviewed")).toBeVisible();

  // The readout keeps row marks apart from per-cell confirms (decision 57); the sweep's Enter is a per-cell confirm,
  // recorded exactly as row review records one.
  await page.getByRole("button", { name: "Pace" }).click();
  await expect(page.getByText("Cell by cell (Enter)")).toBeVisible();
  await expect(page.getByText("Whole rows (⌘Enter)")).toBeVisible();
  // The book's first review, the sweep's, has nothing before it to be timed from.
  await expect(page.getByText("not timed · 1 cell")).toBeVisible();
  await page.keyboard.press("Escape");

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

