import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { createVerifiedUser } from "./helpers";

/**
 * Phase 16 acceptance: the AI proposes the template, and nothing is written until the operator confirms.
 * Needs a worker with AI_PROVIDER=fake, which proposes twelve Burmese fields for a form and six column
 * headers for a table from any page with content (lib/ai/fake.ts).
 */

const FIXTURE = path.join(__dirname, "fixtures", "form.jpg");

async function templateWithSpecimen(page: Page, name: string, kind: "Form" | "Table") {
  await page.getByRole("button", { name: /^(Create your first template|New template)$/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Template name").fill(name);
  await dialog.getByRole("radio", { name: new RegExp(`^${kind}`) }).check();
  await dialog.getByRole("button", { name: "Create template" }).click();
  await expect(page).toHaveURL(/\/templates\/[a-z0-9]{24}$/);
  await page.getByRole("button", { name: "Drop photos here, or click to choose them" }).locator("input[type=file]").setInputFiles(FIXTURE);
  await expect(page.getByRole("button", { name: "Propose fields" })).toBeEnabled({ timeout: 60_000 });
}

async function propose(page: Page) {
  await page.getByRole("button", { name: "Propose fields" }).click();
  const dialog = page.getByRole("dialog", { name: "Propose fields from this page" });
  // The estimate states the work and the time before anything runs, and no money: the suite reads on
  // the server's side, where the figure is the deployment's cost and not a price (Phase 21).
  const estimate = dialog.getByText(/one request to the model\. (Under a minute|About \d+ (minute|hour)s?)\./);
  await expect(estimate).toBeVisible();
  await expect(estimate).not.toContainText("$");
  await dialog.getByRole("button", { name: "Propose fields" }).click();
  const list = dialog.getByRole("list", { name: "Proposed fields in paper order" });
  await expect(list).toBeVisible({ timeout: 90_000 });
  return { dialog, list };
}

test("the AI proposes fields; only the chosen ones are added, in paper order", async ({ page }) => {
  test.setTimeout(240_000);
  await createVerifiedUser(page);
  await page.getByRole("link", { name: "Create your first book" }).click();
  await page.getByLabel("Book name").fill("E2E proposals");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/books\/[a-z0-9]{24}\/templates$/);
  const templatesUrl = new URL(page.url()).pathname;

  await templateWithSpecimen(page, "Registration card", "Form");
  const tree = page.getByRole("list", { name: "Fields and groups in paper order" });
  const form = await propose(page);
  await expect(form.list.getByRole("listitem")).toHaveCount(12);
  await expect(form.dialog.getByText("12 of 12 fields chosen")).toBeVisible();

  // Nothing is in the tree while the proposal is only a proposal.
  await expect(page.getByText("No fields yet.")).toBeVisible();

  await form.list.getByRole("checkbox").nth(5).uncheck();
  await form.dialog.getByRole("button", { name: "Add 11 fields" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Adds 11 fields" });
  await expect(confirm.getByText("1 proposed field is left out")).toBeVisible();
  await confirm.getByRole("button", { name: "Add 11 fields" }).click();
  await expect(page.getByText("Added 11 fields")).toBeVisible();

  // Paper order, the first and last where the page put them, and the unticked one not created.
  const labels = tree.getByRole("listitem");
  await expect(labels).toHaveCount(11);
  await expect(labels.first()).toContainText("အမည်");
  await expect(labels.last()).toContainText("မှတ်ချက်");
  await expect(tree.getByText("မှတ်ပုံတင်အမှတ်", { exact: true })).toHaveCount(0);

  // The same page read as a table proposes its columns instead.
  await page.goto(templatesUrl);
  await templateWithSpecimen(page, "Register", "Table");
  const table = await propose(page);
  await expect(table.list.getByRole("listitem")).toHaveCount(6);
  await expect(table.list.getByText("စဉ်", { exact: true })).toBeVisible();
});
