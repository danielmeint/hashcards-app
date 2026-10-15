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
  // A segmented control now, not a <select>: the pressed segment is the value.
  const choice = (v: string) => page.locator(`#desired-retention button[data-value="${v}"]`);
  await expect(choice("0.9")).toHaveAttribute("aria-pressed", "true");
  await choice("0.8").click();
  await expect(choice("0.8")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#back-btn").click();

  const atEighty = await goodPreview(page);
  // A new card graded Good: FSRS-6 stability 2.3 days, so 2d at 90%. Its
  // forgetting curve is flat, so at 80% that already stretches to 7.65 days.
  expect(atDefault).toBe("2d");
  expect(atEighty).toBe("8d");
});

test("collection settings reach hashcards.toml on leaving Settings", async ({ page, github }) => {
  github.set("Capitals.md", "Q: Japan\nA: Tokyo\n");
  await page.goto("/");
  await expect(page.locator("#drill-all")).toBeVisible();

  await page.locator("#settings-btn").click();
  // The two kinds of setting, told apart.
  await expect(page.locator("#collection-settings .group-title")).toHaveText("Collection");
  await expect(page.locator("#collection-caption")).toContainText("hashcards.toml");
  await expect(page.locator("#device-settings .group-title")).toHaveText("This device");
  await expect(page.locator("#device-settings #theme")).toBeVisible();
  await expect(page.locator("#device-settings #haptic-feedback")).toBeVisible();

  await page.locator('#desired-retention button[data-value="0.85"]').click();
  await page.locator("#interval-fuzz").click();
  // Nothing is written while the screen is open…
  expect(github.files.has("hashcards.toml")).toBe(false);
  await page.locator("#back-btn").click();
  // …and on leaving it, without waiting for a sync.
  await expect
    .poll(() => String(github.files.get("hashcards.toml")?.content ?? ""))
    .toBe("[review]\ndesired_retention = 0.85\nfuzz = false\n");
});
