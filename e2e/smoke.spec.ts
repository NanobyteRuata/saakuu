import { expect, test } from "@playwright/test";

test("home page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "SaaKuu" })).toBeVisible();
});

test("dependencies are healthy", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({
    status: "ok",
    checks: { database: "ok", redis: "ok", storage: "ok" },
  });
});

test("worker completes a no-op job", async ({ request }) => {
  const res = await request.post("/api/health/queue", { data: { echo: "e2e" } });
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, data: { result: { echo: "e2e", dbOk: true } } });
});
