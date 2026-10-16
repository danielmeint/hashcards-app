import { test, expect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { FakeGitHub, readStore } from "./fake-github";

/**
 * Devices that do not know each other's latest state: graded offline on both,
 * a browser cloned with its device name, a local log lost, a clock a day
 * fast, two tabs. Whatever happens, no review is lost and every device ends
 * up agreeing.
 */

const deck = "Q: Japan\nA: Tokyo\n\n---\n\nQ: Peru\nA: Lima\n\n---\n\nQ: Chad\nA: N'Djamena\n";

async function device(
  browser: Browser,
  github: FakeGitHub,
  options: Parameters<Browser["newContext"]>[0] = {}
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ serviceWorkers: "block", ...options });
  const page = await context.newPage();
  await github.install(page);
  return { context, page };
}

/**
 * GitHub unreachable, the dev server not: it serves the app's own chunks,
 * which a real install has in its service worker.
 */
const abort = (route: Route) => route.abort();
const offline = (page: Page) => page.route("https://api.github.com/**", abort);
const online = (page: Page) => page.unroute("https://api.github.com/**", abort);

/** Grade the first `n` cards up, then leave the drill — which syncs. */
async function grade(page: Page, n: number, g = 3): Promise<void> {
  await page.locator("#drill-all").click();
  for (let i = 0; i < n; i++) {
    await page.locator("#reveal-btn").click();
    await page.locator(`.grade-btn[data-grade="${g}"]`).click();
  }
  await page.locator("#end-btn, #done-btn").first().click();
}

type State = { key: string; dueDate: string; stability: number; reviewCount: number };
const schedule = async (page: Page) =>
  ((await readStore(page, "states")) as State[])
    .map(({ key, dueDate, stability, reviewCount }) => ({ key, dueDate, stability, reviewCount }))
    .sort((a, b) => a.key.localeCompare(b.key));

/** Every review on the data branch, from every file. */
function reviewLines(github: FakeGitHub): { path: string; card: string; at: string }[] {
  const out = [];
  for (const [path, text] of github.branchFiles()) {
    if (!path.startsWith("reviews/")) continue;
    for (const line of text.split("\n").filter(Boolean)) {
      const e = JSON.parse(line);
      if ((e.kind ?? "review") === "review") out.push({ path, card: e.card, at: e.at });
    }
  }
  return out;
}

/** Distinct reviews: the same line under two names is one. */
const distinct = (github: FakeGitHub) => new Set(reviewLines(github).map((l) => `${l.card} ${l.at}`)).size;
const landed = (github: FakeGitHub) => github.refWrites.filter((w) => w.ok).length;
const deviceId = (page: Page) => page.evaluate(() => localStorage.getItem("device_id"));

function repo(text = deck): FakeGitHub {
  const github = new FakeGitHub({ owner: "someone", repo: "cards", branch: "main" });
  github.set("Capitals.md", text);
  return github;
}

test("both devices grade one card offline: both reviews count, the same everywhere", async ({ browser }) => {
  // One card, so the drill's shuffle cannot hand the two devices different ones.
  const github = repo("Q: Japan\nA: Tokyo\n");
  const phone = await device(browser, github);
  const laptop = await device(browser, github);
  await phone.page.goto("/");
  await laptop.page.goto("/");
  await expect(phone.page.locator("#drill-all")).toBeVisible();
  await expect(laptop.page.locator("#drill-all")).toBeVisible();

  await offline(phone.page);
  await offline(laptop.page);
  await grade(phone.page, 1, 1); // Again
  await grade(laptop.page, 1, 3); // Good, a moment later
  await online(phone.page);
  await online(laptop.page);

  await phone.page.reload();
  await expect.poll(() => reviewLines(github).length).toBe(1);
  await laptop.page.reload();
  await expect.poll(() => reviewLines(github).length).toBe(2);
  await phone.page.reload();
  // One card, graded twice: once on each device.
  for (const page of [phone.page, laptop.page]) {
    await expect.poll(async () => (await schedule(page)).map((s) => s.reviewCount)).toEqual([2]);
  }
  expect(await schedule(phone.page)).toEqual(await schedule(laptop.page));
  expect(github.unhandled).toEqual([]);
});

test("a browser cloned with its device name: neither overwrites the other", async ({ browser }) => {
  const github = repo();
  const phone = await device(browser, github);
  await phone.page.goto("/");
  await expect(phone.page.locator("#drill-all")).toBeVisible();
  // A backup restored onto a second phone: the same localStorage and IndexedDB.
  const clone = await device(browser, github, {
    storageState: await phone.context.storageState({ indexedDB: true }),
  });
  await clone.page.goto("/");
  await expect(clone.page.locator("#drill-all")).toBeVisible();
  const name = await deviceId(phone.page);
  expect(await deviceId(clone.page)).toBe(name);

  await grade(phone.page, 1);
  await expect.poll(() => reviewLines(github).length).toBe(1);
  let before = landed(github);
  await grade(clone.page, 1);
  await expect.poll(() => landed(github)).toBeGreaterThan(before);

  // The clone found a review under its name that it did not write, and took a
  // new name rather than overwrite it.
  expect(distinct(github)).toBe(2);
  expect(await deviceId(clone.page)).not.toBe(name);
  expect(await deviceId(phone.page)).toBe(name);

  // From here they are two devices: the phone carries on under its name.
  before = landed(github);
  await phone.page.reload();
  await grade(phone.page, 1);
  await expect.poll(() => landed(github)).toBeGreaterThan(before);
  expect(distinct(github)).toBe(3);
  await clone.page.reload();
  await expect
    .poll(async () => JSON.stringify(await schedule(clone.page)))
    .toBe(JSON.stringify(await schedule(phone.page)));
  expect(github.unhandled).toEqual([]);
});

test("a local log lost under a kept device name: its history comes back", async ({ browser }) => {
  const github = repo();
  const phone = await device(browser, github);
  await phone.page.goto("/");
  await grade(phone.page, 1);
  await expect.poll(() => reviewLines(github).length).toBe(1);
  const name = await deviceId(phone.page);

  // IndexedDB gone, localStorage's device_id not.
  const after = await device(browser, github);
  await after.page.addInitScript((id) => localStorage.setItem("device_id", id!), name);
  await after.page.goto("/");
  await expect.poll(async () => (await schedule(after.page)).length).toBe(1);
  expect(await deviceId(after.page)).not.toBe(name);

  const before = landed(github);
  await grade(after.page, 1);
  await expect.poll(() => landed(github)).toBeGreaterThan(before);
  expect(distinct(github)).toBe(2);
  expect(github.unhandled).toEqual([]);
});

test("a clock a day fast: reviews are dated by the correct time, and it says so", async ({ browser }) => {
  const github = repo();
  const phone = await device(browser, github);
  await phone.page.clock.install({ time: new Date(Date.now() + 26 * 3600_000) });
  await phone.page.goto("/");
  await expect(phone.page.locator("#sync-status-text")).toContainText(
    "This device's clock is fast by 26 hours"
  );

  const before = Date.now();
  await grade(phone.page, 1);
  await expect.poll(() => reviewLines(github).length).toBe(1);
  expect(Math.abs(Date.parse(reviewLines(github)[0].at) - before)).toBeLessThan(5 * 60_000);
  // Today is today, not tomorrow.
  const today = new Date();
  await expect(phone.page.locator(".hero-date")).toHaveText(
    `${today.toLocaleDateString("en-GB", { weekday: "long" })}, ` +
      today.toLocaleDateString("en-GB", { day: "numeric", month: "long" })
  );
});

test("two tabs of one browser: both reviews reach GitHub", async ({ browser }) => {
  const github = repo();
  const { context, page: a } = await device(browser, github);
  await a.goto("/");
  await expect(a.locator("#drill-all")).toBeVisible();
  const b = await context.newPage();
  await github.install(b);
  await b.goto("/");
  await expect(b.locator("#drill-all")).toBeVisible();

  await a.locator("#drill-all").click();
  await b.locator("#drill-all").click();
  for (const p of [a, b]) {
    await p.locator("#reveal-btn").click();
    await p.locator('.grade-btn[data-grade="3"]').click();
    await p.locator("#end-btn, #done-btn").first().click();
  }
  await expect.poll(() => reviewLines(github).length).toBe(2);
  expect(await deviceId(a)).toBe(await deviceId(b));
  expect(github.unhandled).toEqual([]);
});
