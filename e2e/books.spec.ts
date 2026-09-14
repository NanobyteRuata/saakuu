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

  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("Vaccination cards 2023");
  await page.getByRole("button", { name: "Next: columns" }).click();
  const labels = ["Full name", "Date of birth", "Village", "Weight (kg)", "Doses given"];
  for (const [i, label] of labels.entries()) {
    if (i > 0) await page.getByRole("button", { name: "Add column" }).click();
    await page.getByLabel(`Column ${i + 1} label`).fill(label);
  }
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}$/);
  const bookId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  await expect(page.getByRole("columnheader")).toHaveCount(5);
  const created = await columnsOf(page, bookId);
  expect(created.map((c) => c.key)).toEqual(["full_name", "date_of_birth", "village", "weight_kg", "doses_given"]);

  const dialog = page.getByRole("dialog");
  await page.getByRole("navigation", { name: "Book sections" }).getByRole("link", { name: "Settings" }).click();

  // Rename: safe, no impact screen, key and id unchanged.
  await page.getByRole("button", { name: "Edit output table" }).click();
  await dialog.getByLabel("Column 1 label").fill("Patient name");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Output table updated.")).toBeVisible();
  const renamed = await columnsOf(page, bookId);
  expect(renamed[0]).toMatchObject({ id: created[0]?.id, key: "full_name", label: "Patient name" });

  // Delete: stops on the impact report, applies on confirm.
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
