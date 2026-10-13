import { test, expect, readStore } from "./fake-github";

const deck = (...qs: string[]) =>
  qs.map((q) => `Q: ${q}\nA: answer to ${q}\n`).join("\n---\n\n");

test("a graded card survives closing the app mid-session", async ({ page, github }) => {
  github.set("Capitals.md", deck("Japan", "Peru", "Chad"));
  await page.goto("/");
  await page.locator("#drill-all").click();

  await page.locator("#reveal-btn").click();
  await page.locator('.grade-btn[data-grade="3"]').click();

  // The review is in IndexedDB the moment it is graded, not at session end.
  await expect.poll(async () => (await readStore(page, "performances")).length).toBe(1);

  // Closing the app is a reload here; what is left must be resumable.
  await page.reload();
  await expect(page.locator(".resume-banner")).toContainText("2 cards left");
  expect(await readStore(page, "performances")).toHaveLength(1);
  expect(github.unhandled).toEqual([]);
});

test("revealing the answer does not move the card", async ({ page, github }) => {
  github.set("Capitals.md", deck("Japan"));
  await page.goto("/");
  await page.locator("#drill-all").click();
  const card = page.locator(".card-container .card").first();

  const before = await card.boundingBox();
  await page.locator("#reveal-btn").click();
  await expect(page.locator(".grade-btn").first()).toBeVisible();
  expect((await card.boundingBox())?.y).toBe(before?.y);
});
