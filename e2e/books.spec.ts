import { expect, test, type Page } from "@playwright/test";

import { createVerifiedUser } from "./helpers";

/** Phase 2 acceptance: create a book with 5 columns, rename one, delete one through the impact report. */

type Column = { id: string; key: string; label: string };

async function columnsOf(page: Page, bookId: string): Promise<Column[]> {
  const res = await page.request.get(`/api/books/${bookId}/columns`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: Column[] }).data;
}

test("create a book with 5 columns, rename a column, delete a column through the impact report", async ({ page }) => {
  await createVerifiedUser(page);

  // Creating a book is one step since Phase 14: a name, and nothing else. Columns are authored where
  // they live, on the Result Table, or proposed from a template's fields.
  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("Vaccination cards 2023");
  await page.getByRole("button", { name: "Create book" }).click();
  // Creating a book lands on Templates (Phase 10): the table stays empty until a template reads a document.
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}\/templates$/);
  const bookId = new URL(page.url()).pathname.split("/").at(-2) ?? "";

  // The counts are part of each workspace link's accessible name (Phase 13), so match the label.
  await page.getByRole("navigation", { name: "Book workspaces" }).getByRole("link", { name: /^Result Table/ }).click();
  await expect(page.getByText("This book has no columns yet")).toBeVisible();

  const dialog = page.getByRole("dialog");
  // The column editor is reachable from the empty table, which is exactly when the columns are missing.
  await page.getByRole("button", { name: "Edit output table" }).click();
  const labels = ["Full name", "Date of birth", "Village", "Weight (kg)", "Doses given"];
  for (const [i, label] of labels.entries()) {
    await dialog.getByRole("button", { name: "Add column" }).click();
    await dialog.getByLabel(`Column ${i + 1} label`).fill(label);
  }
  await dialog.getByRole("button", { name: "Save changes" }).click();
  // The dialog closes only once the apply has come back, which is the barrier worth waiting on: the
  // success toast lingers and would match the next step's assertion too.
  await expect(dialog).toBeHidden();
  const created = await columnsOf(page, bookId);
  expect(created.map((c) => c.key)).toEqual(["full_name", "date_of_birth", "village", "weight_kg", "doses_given"]);

  // A book with columns but no rows still offers the editor.
  await page.reload();
  await expect(page.getByText("No rows yet")).toBeVisible();

  // Rename: safe, no impact screen, key and id unchanged.
  await page.getByRole("button", { name: "Edit output table" }).click();
  await dialog.getByLabel("Column 1 label").fill("Patient name");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();
  const renamed = await columnsOf(page, bookId);
  expect(renamed[0]).toMatchObject({ id: created[0]?.id, key: "full_name", label: "Patient name" });

  // Delete: stops on the impact report, applies on confirm.
  await page.reload();
  await page.getByRole("button", { name: "Edit output table" }).click();
  await dialog.getByRole("button", { name: "Remove Weight (kg)" }).click();
  await dialog.getByRole("button", { name: "Save changes" }).click();
  const impact = dialog.getByTestId("impact-summary");
  await expect(impact.getByText("Weight (kg)")).toBeVisible();
  await expect(impact.getByText("0 of the 0 affected cells have been edited by you.")).toBeVisible();
  await expect(impact.getByText("No template mappings break.")).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm and apply" }).click();
  await expect(dialog).toBeHidden();
  expect((await columnsOf(page, bookId)).map((c) => c.key)).toEqual(["full_name", "date_of_birth", "village", "doses_given"]);

  // The server enforces the preview: a stale impact hash is refused.
  const stale = await page.request.post(`/api/books/${bookId}/columns/apply`, {
    data: { ops: [{ kind: "delete", id: renamed[0]?.id }], impactHash: `sha256:${"0".repeat(64)}`, confirm: true },
  });
  expect(stale.status()).toBe(409);
});
