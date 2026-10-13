import { test, expect } from "./fake-github";

// A 2x2 red PNG: small, but a real image a browser has to decode.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAwMDAAAANBAEAr8eNnQAAAABJRU5ErkJggg==",
  "base64"
);

/** Whether the card on screen shows a decoded image from the local copy. */
async function imageState(page: import("@playwright/test").Page) {
  const img = page.locator(".card-container .card img").first();
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete)).toBe(true);
  return img.evaluate((el: HTMLImageElement) => ({
    src: el.src,
    width: el.naturalWidth,
  }));
}

test("an image in a private repo renders, from the copy sync stored", async ({ page, github }) => {
  github.set("art/paintings.md", "Q: Which colour?\n\n![a square](red.png)\n\nA: Red\n");
  github.set("art/red.png", PNG);

  await page.goto("/");
  await page.locator("#drill-all").click();

  const state = await imageState(page);
  expect(state.src).toMatch(/^blob:/);
  expect(state.width).toBe(2);
  expect(github.rawRequests).toEqual([]);
  expect(github.unhandled).toEqual([]);
});

test("the image still renders offline", async ({ page, github }) => {
  github.set("art/paintings.md", "Q: Which colour?\n\n![](@/art/red.png)\n\nA: Red\n");
  github.set("art/red.png", PNG);
  await page.goto("/");
  await expect(page.locator("#drill-all")).toBeVisible();

  // Vite's dev server is not a service worker, so the page itself cannot load
  // offline here: the app is reloaded online, then the network goes away for
  // everything it would have to fetch.
  await page.reload();
  await page.route("https://api.github.com/**", (route) => route.abort("internetdisconnected"));
  await page.locator("#drill-all").click();

  const state = await imageState(page);
  expect(state.src).toMatch(/^blob:/);
  expect(state.width).toBe(2);
});
