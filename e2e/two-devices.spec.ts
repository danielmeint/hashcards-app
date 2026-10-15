import { test, expect, type Browser, type Page } from "@playwright/test";
import { FakeGitHub, readStore } from "./fake-github";

/**
 * Two devices, one repository, and nothing between them but the data branch:
 * each grades on its own, syncs, and both end up with the same schedule —
 * without either ever writing a file the other writes.
 */

const deck = "ID: japan\nQ: Japan\nA: Tokyo\n\n---\n\nID: peru\nQ: Peru\nA: Lima\n";

async function device(browser: Browser, github: FakeGitHub): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  await github.install(page);
  return page;
}

/**
 * Grade whichever card is up Good, `n` times, then leave the drill — which
 * pushes. `End` mid-drill, `Done` on the summary once every card is graded.
 */
async function drill(page: Page, n: number, leave: "#end-btn" | "#done-btn"): Promise<void> {
  await page.locator("#drill-all").click();
  for (let i = 0; i < n; i++) {
    await page.locator("#reveal-btn").click();
    await page.locator('.grade-btn[data-grade="3"]').click();
  }
  await page.locator(leave).click();
}

type State = { key: string; dueDate: string; stability: number; reviewCount: number };
const schedule = async (page: Page) =>
  ((await readStore(page, "states")) as State[])
    .map(({ key, dueDate, stability, reviewCount }) => ({ key, dueDate, stability, reviewCount }))
    .sort((a, b) => a.key.localeCompare(b.key));

test("two devices converge through the data branch", async ({ browser }) => {
  const github = new FakeGitHub({ owner: "someone", repo: "cards", branch: "main" });
  github.set("Capitals.md", deck);
  const reviewFiles = () => [...github.branchFiles().keys()].filter((p) => p.startsWith("reviews/"));

  const phone = await device(browser, github);
  await phone.goto("/");
  await drill(phone, 1, "#end-btn");
  await expect.poll(reviewFiles).toHaveLength(1);

  // The laptop opens afterwards and pulls the phone's review — so the card the
  // phone learned is not due here either, and only the other one is left.
  const laptop = await device(browser, github);
  await laptop.goto("/");
  await expect.poll(async () => (await schedule(laptop)).length).toBe(1);
  await drill(laptop, 1, "#done-btn");
  await expect.poll(reviewFiles).toHaveLength(2);

  // Back on the phone, a sync on opening brings the laptop's work across.
  await phone.reload();
  await expect.poll(async () => (await schedule(phone)).map((s) => s.reviewCount).join()).toBe(
    (await schedule(laptop)).map((s) => s.reviewCount).join()
  );
  expect(await schedule(phone)).toEqual(await schedule(laptop));
  expect((await schedule(phone)).map((s) => s.key)).toEqual(["someone/cards/japan", "someone/cards/peru"]);
  // Every move of the branch was a fast-forward that landed.
  expect(github.refWrites.every((w) => w.ok)).toBe(true);
  expect(github.unhandled).toEqual([]);
});
