import { writeFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

/**
 * The README's screenshots, from the real app in demo mode: never mockups.
 * Run after a UI change and commit what changes in `docs/screenshots/`.
 *
 * Each shot is re-encoded as WebP in the page itself (Chrome's canvas encoder)
 * and scaled to the width the README shows it at, twice over for sharp
 * screens, which keeps the set small without an image tool to install.
 */

const OUT = "docs/screenshots";

/** The demo shuffles its queue; a fixed seed makes the same card come up each run. */
async function seedRandom(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let a = 0x2f62e0;
    Math.random = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
}

async function save(page: Page, name: string, width: number, quality = 0.82): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const png = (await page.screenshot()).toString("base64");
  const webp = await page.evaluate(
    async ({ png, width, quality }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.round((img.height * width) / img.width);
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/webp", quality).split(",")[1];
    },
    { png, width, quality }
  );
  writeFileSync(`${OUT}/${name}.webp`, Buffer.from(webp, "base64"));
}

async function openDemo(page: Page): Promise<void> {
  await seedRandom(page);
  await page.goto("/#demo");
  await expect(page.locator("#drill-all")).toBeVisible();
}

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("light: Today, Review, Inbox, Stats", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openDemo(page);
    await save(page, "phone-today", 540);

    await page.locator(".deck-row", { hasText: "Programming" }).click();
    await page.locator("#reveal-btn").click();
    await save(page, "phone-review", 540);
    await page.locator("#end-btn").click();

    await page.locator("#inbox-btn").click();
    await expect(page.locator(".inbox .card")).toBeVisible();
    await save(page, "phone-inbox", 540);
    await page.locator("#inbox-back").click();

    await page.locator("#stats-btn").click();
    await expect(page.locator(".stats-view")).toBeVisible();
    await save(page, "phone-stats", 540);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  test("dark: Review", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openDemo(page);
    // The whole day's queue, so the desktop shot is not the phone's card again.
    await page.locator("#drill-all").click();
    await page.locator("#reveal-btn").click();
    await save(page, "desktop-review-dark", 1280, 0.8);
  });
});
