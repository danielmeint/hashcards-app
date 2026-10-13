import { test, expect } from "./fake-github";

/** The interval the Good button offers on the first card of a fresh drill. */
async function goodPreview(page: import("@playwright/test").Page): Promise<string> {
  await page.locator("#drill-all").click();
  await page.locator("#reveal-btn").click();
  return (await page.locator('.grade-btn[data-grade="3"] .interval-preview').textContent()) ?? "";
}

test("a lower desired retention schedules further out", async ({ page, github }) => {
  github.set("Capitals.md", "Q: Japan\nA: Tokyo\n");
  await page.goto("/");
  const atDefault = await goodPreview(page);
  await page.locator("#end-btn").click();

  await page.locator("#settings-btn").click();
  await expect(page.locator("#desired-retention")).toHaveValue("0.9");
  await page.locator("#desired-retention").selectOption("0.7");
  await page.locator("#back-btn").click();

  const atSeventy = await goodPreview(page);
  // A new card graded Good: FSRS-6 stability 2.3 days, so 2d at 90%. Its
  // forgetting curve is flat, so at 70% that stretches to ~21 days.
  expect(atDefault).toBe("2d");
  expect(atSeventy).toBe("3w");
});
