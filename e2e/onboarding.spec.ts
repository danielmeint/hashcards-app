import { test, expect, type Page } from "@playwright/test";
import { FakeGitHub, readStore } from "./fake-github";

/**
 * A newcomer's first minute: the welcome and its three ways in, the demo
 * end to end, and proof that none of the demo is left behind for the real
 * collection signed in afterwards.
 */

const TEMPLATE =
  "https://github.com/new?template_owner=danielmeint&template_name=hashcards-starter";

/** Every request this page makes to GitHub, for asserting the demo made none. */
function githubRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (req) => {
    const host = new URL(req.url()).hostname;
    if (host.endsWith("github.com") || host.endsWith("githubusercontent.com")) seen.push(req.url());
  });
  return seen;
}

async function reviewOne(page: Page): Promise<void> {
  const before = await page.locator(".progress-count").textContent();
  await page.locator("#reveal-btn").click();
  await page.locator('.grade-btn[data-grade="3"]').click();
  await expect(page.locator(".progress-count")).not.toHaveText(before ?? "");
}

test("welcome, demo, and a real collection that never sees the demo", async ({ page }) => {
  const github = new FakeGitHub({ owner: "someone", repo: "cards", branch: "main" });
  github.set("Capitals.md", "Q: Capital of Japan?\nA: Tokyo\n");
  await github.install(page, { signedIn: false });

  // --- The welcome, signed out ---
  await page.goto("/");
  await expect(page.locator(".welcome-view")).toBeVisible();
  await expect(page.locator("#path-demo")).toContainText("Try the demo");
  await expect(page.locator("#path-template")).toContainText("Start your own collection");
  await expect(page.locator("#path-existing")).toContainText("Already have cards?");
  const template = page.locator("#template-link");
  await expect(template).toHaveAttribute("href", TEMPLATE);
  await expect(template).toHaveAttribute("target", "_blank");
  await expect(page.locator("#grant-hint")).toHaveText(
    "When GitHub asks which repositories, include your new one."
  );
  await expect(page.locator("#signin-btn")).toBeVisible();
  await expect(page.locator("#spec-link")).toHaveAttribute(
    "href",
    "https://github.com/danielmeint/hashcards-app/blob/main/CARD_FORMAT_SPEC.md"
  );

  // --- The demo ---
  const requests = githubRequests(page);
  await page.locator("#demo-btn").click();
  await expect(page.locator(".demo-bar")).toContainText("nothing is saved");
  await expect(page.locator("#drill-all")).toBeVisible();
  expect(Number(await page.locator(".hero-number").textContent())).toBeGreaterThan(5);
  await expect(page.locator("#inbox-count")).toHaveText("3 drafts");

  await page.locator("#drill-all").click();
  await reviewOne(page);
  await reviewOne(page);
  await page.locator("#end-btn").click();
  await expect(page.locator(".deck-list-view")).toBeVisible();

  await page.locator("#inbox-btn").click();
  const first = await page.locator(".inbox .card-content").textContent();
  await page.locator("#keep-btn").click();
  await expect(page.locator(".inbox .card-content")).not.toHaveText(first ?? "");
  await page.locator("#inbox-back").click();
  await expect(page.locator("#inbox-count")).toHaveText("2 drafts");

  await page.locator("#stats-btn").click();
  await expect(page.locator(".stats-view")).toBeVisible();
  await expect(page.locator(".leeches")).toContainText("time spent talking at the table");
  await page.locator("#back-btn").click();

  // --- A reload is a fresh demo ---
  await page.reload();
  await expect(page.locator(".demo-bar")).toBeVisible();
  await expect(page.locator("#inbox-count")).toHaveText("3 drafts");
  await expect(page.locator(".resume-banner")).toHaveCount(0);
  expect(requests).toEqual([]);

  // Nothing reached the real database.
  expect(await readStore(page, "reviews")).toEqual([]);
  expect(await readStore(page, "deckFiles")).toEqual([]);

  // --- Signing in for real ---
  await github.signIn(page);
  await page.locator("#demo-exit").click();
  await expect(page.locator("#drill-all")).toBeVisible();
  await expect(page.locator(".demo-bar")).toHaveCount(0);
  await expect(page.locator(".deck-row")).toHaveCount(1);
  await expect(page.locator(".deck-row")).toContainText("Capitals");
  await expect(page.locator("#inbox-btn")).toHaveCount(0);
  expect(await readStore(page, "reviews")).toEqual([]);
  expect(
    await page.evaluate(() => ({
      repos: JSON.parse(localStorage.getItem("repos") ?? "[]"),
      reset: localStorage.getItem("new_cards_reset"),
    }))
  ).toEqual({ repos: [{ owner: "someone", repo: "cards", branch: "main" }], reset: null });
  expect(github.unhandled).toEqual([]);
});

test("the token path is one step from the welcome, and back", async ({ page }) => {
  const github = new FakeGitHub({ owner: "someone", repo: "cards", branch: "main" });
  await github.install(page, { signedIn: false });
  await page.goto("/");
  // The token path is still one step away, in Settings, and back again.
  await page.locator("#pat-link").click();
  await expect(page.locator("#pat")).toBeAttached();
  await page.locator("#back-btn").click();
  await expect(page.locator(".welcome-view")).toBeVisible();
});
