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
  await expect.poll(async () => (await readStore(page, "states")).length).toBe(1);

  // Closing the app is a reload here; what is left must be resumable.
  await page.reload();
  await expect(page.locator(".resume-banner")).toContainText("2 cards left");
  expect(await readStore(page, "states")).toHaveLength(1);
  expect(github.unhandled).toEqual([]);
});

test("revealing the answer does not move the card", async ({ page, github }) => {
  github.set("Capitals.md", deck("Japan"));
  await page.goto("/");
  await page.locator("#drill-all").click();
  const card = page.locator(".card-container .card").first();
  const question = page.locator(".card-content > :first-child").first();

  const before = [await card.boundingBox(), await question.boundingBox()];
  await page.locator("#reveal-btn").click();
  await expect(page.locator(".grade-btn").first()).toBeVisible();
  // Not its top, not its height: the grade buttons take exactly the room the
  // reveal button did, or the centred question jumps as the card shrinks.
  expect([await card.boundingBox(), await question.boundingBox()]).toEqual(before);
});

test("a grade is said back: which button, and the interval it set", async ({ page, github }) => {
  github.set("Capitals.md", deck("Japan", "Peru"));
  await page.goto("/");
  await page.locator("#drill-all").click();
  await page.locator("#reveal-btn").click();
  await page.locator('.grade-btn[data-grade="4"]').click();

  await expect(page.locator("#reveal-btn")).toHaveAttribute("data-graded", "4");
  await expect(page.locator(".controls-hint .graded")).toHaveText(/^Easy · \d+d$/);
  // Shown until the next answer is, then the usual hint.
  await page.locator("#reveal-btn").click();
  await expect(page.locator(".controls-hint .graded")).toHaveCount(0);

  // An undo takes it back: nothing graded to confirm.
  await page.locator("#undo-btn").click();
  await expect(page.locator("#reveal-btn")).not.toHaveAttribute("data-graded");
  await expect(page.locator(".controls-hint .graded")).toHaveCount(0);
});

test("ending a drill saves its reviews to the data branch", async ({ page, github }) => {
  github.set("Capitals.md", deck("Japan", "Peru"));
  await page.goto("/");
  await page.locator("#drill-all").click();
  await page.locator("#reveal-btn").click();
  await page.locator('.grade-btn[data-grade="3"]').click();
  await page.locator("#end-btn").click();

  const logs = () => [...github.branchFiles().keys()].filter((p) => p.startsWith("reviews/"));
  await expect.poll(logs).toHaveLength(1);
  const [path] = logs();
  expect(path).toMatch(/^reviews\/\d{4}-\d{2}\.[0-9a-f]{8}\.jsonl$/);
  const [line] = github.branchFiles().get(path)!.trim().split("\n");
  expect(JSON.parse(line)).toMatchObject({ v: 2, grade: 3 });
  expect(JSON.parse(line).card).toMatch(/^h:[0-9a-f]{16}$/);
  expect(JSON.parse(line).ms).toBeGreaterThan(0);
  // Nothing of it on main: no state file, no v1 log.
  expect(github.stateWrites).toEqual([]);
  expect([...github.files.keys()]).toEqual(["Capitals.md"]);
  expect(github.unhandled).toEqual([]);
});
