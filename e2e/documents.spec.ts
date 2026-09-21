import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { createVerifiedUser } from "./helpers";

/**
 * Phase 18: the phone uploads, the batch dialog uploads, and Documents can find both by upload day,
 * sort them by it, narrow them by one Status, and watch them being read in the run drawer.
 * Needs the app with EMAIL_TRANSPORT=test and a worker with AI_PROVIDER=fake (see README → Checks).
 */

const FIXTURE = readFileSync(path.join(__dirname, "fixtures", "form.jpg"));
// Named apart, so the sort can be seen: each upload's label is its file name.
const PHONE_FILE = { name: "from-phone.jpg", mimeType: "image/jpeg", buffer: FIXTURE };
const BATCH_FILE = { name: "from-batch.jpg", mimeType: "image/jpeg", buffer: FIXTURE };

test("phone upload → batch upload → upload-day filter and sort → status → run drawer", async ({ page }) => {
  test.setTimeout(180_000);
  await createVerifiedUser(page);

  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("E2E register");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}\/templates$/);
  const bookUrl = new URL(page.url()).pathname.replace(/\/templates$/, "");

  await page.getByRole("button", { name: "Create your first template" }).click();
  const createDialog = page.getByRole("dialog");
  await createDialog.getByLabel("Template name").fill("Clinic card");
  await createDialog.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}$/);
  await page.getByLabel("New field label, as written on the paper").fill("Name");
  await page.getByRole("button", { name: "Add field" }).click();
  await expect(page.getByRole("list", { name: "Fields and groups in paper order" }).getByText("Name", { exact: true })).toBeVisible();

  // Taken before the first upload, so a run that crosses midnight still looks for the day they went up.
  const today = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  // A phone: the workspaces are not there, the reason is, and a photo goes into the chosen template.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${bookUrl}/documents`);
  await expect(page.getByText("which needs a wider screen")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Book workspaces" })).toBeHidden();
  await expect(page.getByLabel("Template")).toContainText("Clinic card");
  await page.getByLabel("Choose photos or PDFs").setInputFiles(PHONE_FILE);
  const uploads = page.getByRole("list", { name: "Uploads" });
  await expect(uploads.getByText("Ready")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("1 document added to Clinic card")).toBeVisible();
  await expect(page.getByText("review needs a wider screen")).toBeVisible();

  // A computer: the batch dialog, end to end, adds a second one (the coverage Phase 15 handed back).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${bookUrl}/documents`);
  await page.getByRole("button", { name: "Upload documents" }).click();
  const uploadDialog = page.getByRole("dialog");
  await uploadDialog.locator("input[type=file]").setInputFiles(BATCH_FILE);
  await expect(uploadDialog.getByText("1 of 1 file uploaded")).toBeVisible({ timeout: 60_000 });
  await uploadDialog.getByRole("button", { name: "Done" }).click();
  const table = page.getByRole("table", { name: "Documents" });
  await expect(table.getByRole("row")).toHaveCount(3); // header + 2

  // Both went up today, and newest-first puts the batch upload's document on top.
  await page.getByLabel("Uploaded").click();
  await page.getByRole("option", { name: `Uploaded ${today}` }).click();
  await expect(page).toHaveURL(new RegExp(`uploadedOn=${today}`));
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row").nth(1)).toContainText("from-phone.jpg");
  await page.getByLabel("Sort").click();
  await page.getByRole("option", { name: "Newest upload first" }).click();
  await expect(page).toHaveURL(/sort=newest/);
  await expect(table.getByRole("row").nth(1)).toContainText("from-batch.jpg");

  // One Status select: nothing has been read, then both are read and the drawer shows it per page.
  await page.getByLabel("Status").click();
  await page.getByRole("option", { name: "Not read yet" }).click();
  await expect(page).toHaveURL(/status=not-read/);
  await expect(table.getByRole("row")).toHaveCount(3);

  await page.getByRole("button", { name: "Runs", exact: true }).click();
  const runs = page.getByRole("dialog", { name: "Extraction runs" });
  await expect(runs.getByText("Nothing has been read in the last day")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("checkbox", { name: "Select all loaded documents" }).check();
  await page.getByRole("button", { name: "Extract", exact: true }).click();
  await page.getByRole("button", { name: "Extract 2 documents" }).click();
  await page.getByRole("button", { name: /^Runs/ }).click();
  await expect(runs.getByRole("list", { name: "Pages" }).getByText("Page 1: Read")).toHaveCount(2, { timeout: 90_000 });
  await expect(runs.getByText("Nothing is being read, and nothing has failed.")).toBeVisible();
});
