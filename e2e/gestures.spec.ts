import type { Page } from "@playwright/test";
import { test, expect, readStore } from "./fake-github";

/**
 * Swipes as real touches, through Chrome's own input pipeline — so
 * `touch-action`, the browser's pan detection and pointer capture all take
 * part, which jsdom cannot stand in for.
 *
 * Each event carries its own timestamp, which Chrome passes through as the
 * event's `timeStamp`. Waiting between sends instead measured the protocol's
 * round trip (~33ms a move), which turned every "flick" into a slow drag.
 */
async function touchDrag(
  page: Page,
  { dx, dy = 0, ms, holdMs = 0 }: { dx: number; dy?: number; ms: number; holdMs?: number }
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator(".card-container").boundingBox())!;
  const x0 = box.x + box.width / 2 - dx / 2;
  const y0 = box.y + box.height / 2 - dy / 2;
  const start = Date.now();
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", atMs: number, x = 0, y = 0) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      timestamp: (start + atMs) / 1000,
    });

  const steps = 6;
  await touch("touchStart", 0, x0, y0);
  for (let i = 1; i <= steps; i++) {
    await touch("touchMove", (ms * i) / steps, x0 + (dx * i) / steps, y0 + (dy * i) / steps);
  }
  await touch("touchEnd", ms + 5 + holdMs);
  await cdp.detach();
}

const graded = async (page: Page) => (await readStore(page, "performances")).length;

test.beforeEach(async ({ page, github }, info) => {
  test.skip(!info.project.use.hasTouch, "touch gestures are the phone's");
  github.set("Capitals.md", "Q: Japan\nA: Tokyo\n\n---\n\nQ: Peru\nA: Lima\n");
  await page.goto("/");
  await page.locator("#drill-all").click();
  await page.locator("#reveal-btn").click();
});

test("a short fast flick grades the card", async ({ page }) => {
  await touchDrag(page, { dx: 60, ms: 60 }); // 1 px/ms: an ordinary thumb flick
  await expect.poll(() => graded(page)).toBe(1);
});

test("the same distance, dragged slowly and held, springs back", async ({ page }) => {
  await touchDrag(page, { dx: 60, ms: 600, holdMs: 250 });
  await page.waitForTimeout(300);
  expect(await graded(page)).toBe(0);
  await expect(page.locator(".grade-btn").first()).toBeVisible();
});

test("a slow drag past the distance still grades, as it always has", async ({ page }) => {
  await touchDrag(page, { dx: 120, ms: 600, holdMs: 250 });
  await expect.poll(() => graded(page)).toBe(1);
});

test("a vertical drag is not a swipe", async ({ page }) => {
  await touchDrag(page, { dx: 0, dy: 160, ms: 60 });
  await page.waitForTimeout(300);
  expect(await graded(page)).toBe(0);
});
