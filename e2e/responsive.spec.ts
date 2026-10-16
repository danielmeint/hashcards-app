import type { Locator, Page } from "@playwright/test";
import { test, expect, FakeGitHub } from "./fake-github";

/**
 * The responsive tour (PLAN-1.0 M8): every screen at a phone, a small phone, an
 * iPad in portrait and a desktop, in both palettes. On each one the page must
 * not scroll sideways, and the controls that screen exists for must be on it.
 *
 * Screenshots land in `test-results/responsive/` for a person to look at; they
 * are not compared against anything, since fonts and antialiasing differ by
 * machine. What is asserted is geometry.
 */

/** A small collection shaped like a real one: folders, and the awkward cards. */
function seed(github: FakeGitHub): void {
  const qa = (pairs: [string, string][]) =>
    pairs.map(([q, a]) => `Q: ${q}\nA: ${a}\n`).join("\n---\n\n");
  github.set(
    "geography/europe/Central Europe.md",
    qa([
      ["What is the capital of Austria?", "Vienna"],
      ["What is the capital of Czechia?", "Prague"],
      ["What is the capital of Hungary?", "Budapest"],
    ])
  );
  github.set(
    "geography/europe/Nordic & Baltic.md",
    qa([
      ["What is the capital of Estonia?", "Tallinn"],
      ["What is the capital of Latvia?", "Riga"],
    ])
  );
  github.set("geography/germany/States.md", qa([["Capital of Bavaria?", "Munich"]]));
  github.set(
    "cs/Kubernetes.md",
    "C: In Kubernetes, a [Deployment] manages a ReplicaSet, which in turn manages Pods.\n"
  );
  github.set(
    "cs/Rust.md",
    [
      "Q: What does this print?",
      "",
      "```rust",
      "fn main() {",
      "    let v = vec![1, 2, 3];",
      '    println!("{}", v.iter().map(|x| x * 2).sum::<i32>());',
      "}",
      "```",
      "",
      "A: `12`: each element doubled, then summed.",
      "",
    ].join("\n")
  );
  github.set(
    "cs/Networking.md",
    [
      "Q: Compare TCP and UDP.",
      "A: |  | TCP | UDP |",
      "|---|---|---|",
      "| Ordered | Yes | No |",
      "| Reliable | Yes | No |",
      "| Overhead | Higher | Lower |",
      "| Connection setup | Three-way handshake | None |",
      "",
    ].join("\n")
  );
  github.set("Reading list.md", qa([["Who wrote *Middlemarch*?", "George Eliot"]]));
  // A deck someone broke on GitHub, with a long name: Today says so, and the
  // panel must wrap rather than push the page sideways.
  github.set("cs/Distributed systems reading notes from the long weekend.md", "Q: What is a quorum?\n");
  // Two drafts for the Inbox, the way an agent leaves them: one with tags and
  // an Extra note, one cloze with two deletions.
  github.set(
    "cs/Drafts.md",
    [
      "Status: draft",
      "Tags: cka/workloads, kubectl",
      "Q: Which command rolls a Deployment back to its previous revision?",
      "A: `kubectl rollout undo deployment/<name>`",
      "Extra: Add `--to-revision=N` to pick a specific one from `rollout history`.",
      "",
      "---",
      "",
      "Status: draft",
      "C: A [StatefulSet] gives each Pod a stable [network identity] and its own volume.",
      "",
    ].join("\n")
  );
}

type Width = 320 | 390 | 820 | 1440;
type Scheme = "light" | "dark";

/** Phones and the iPad run on the touch project; the desktop on the mouse one. */
const WIDTHS: Record<string, Width[]> = { phone: [320, 390, 820], desktop: [820, 1440] };
const HEIGHT: Record<Width, number> = { 320: 568, 390: 844, 820: 1180, 1440: 900 };

async function noSidewaysScroll(page: Page, screen: string): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `${screen} scrolls sideways`).toBeLessThanOrEqual(innerWidth);
}

/**
 * Wholly inside the viewport. `scroll` brings something further down the page
 * into view first, for screens taller than a phone — what matters there is
 * that it is reachable and not cut off at the sides.
 */
async function fullyVisible(page: Page, target: Locator, scroll = false): Promise<void> {
  if (scroll) await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const { width, height } = page.viewportSize()!;
  expect(box, "not rendered").not.toBeNull();
  const what = await target.evaluate(
    (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${[...el.classList].join(".")}`
  );
  expect(box!.x, `${what} is off the left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what} is off the right edge`).toBeLessThanOrEqual(width + 0.5);
  expect(box!.y, `${what} is off the top`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${what} is off the bottom`).toBeLessThanOrEqual(height + 0.5);
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  // Fonts load from the network and may not be there; wait for whatever will.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `test-results/responsive/${name}.png`, fullPage });
}

async function check(page: Page, name: string, controls: Locator[], fullPage = false) {
  await noSidewaysScroll(page, name);
  for (const control of controls) await fullyVisible(page, control, fullPage);
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, name, fullPage);
}

/**
 * One deck's single card: question, answer, then a grade — which ends that
 * deck's drill on the finished screen, and leaves Statistics something to draw.
 */
async function review(page: Page, deck: string, tag: string, grade: string): Promise<void> {
  const name = `${tag}-review-${deck.toLowerCase()}`;
  await page.locator(".deck-row", { hasText: deck }).click();
  await expect(page.locator("#reveal-btn")).toBeVisible();
  await check(page, `${name}-question`, [
    page.locator("#end-btn"),
    page.locator("#undo-btn"),
    page.locator(".card-container .card"),
    page.locator("#reveal-btn"),
  ]);
  await page.locator("#reveal-btn").click();
  await check(page, `${name}-answer`, [
    page.locator(".card-container .card"),
    ...(await page.locator(".grade-btn").all()),
  ]);
  if (deck === "Rust") {
    // The editor sheet opens over the card it edits.
    await page.locator("#edit-link").click();
    await expect(page.locator(".editor-text")).toBeVisible();
    await check(page, `${name}-editor`, [page.locator(".editor-save"), page.locator(".editor-cancel")]);
    await page.locator(".editor-cancel").click();
    await expect(page.locator(".editor-backdrop")).toHaveCount(0);
  }
  if (deck === "Kubernetes" && (await page.evaluate(() => "ontouchstart" in window))) {
    await midSwipe(page, `${name}-swipe`);
  }
  await page.locator(`.grade-btn[data-grade="${grade}"]`).click();
  if (grade === "1") {
    // Forgot brings the card round again; undo is how you take that back.
    await expect(page.locator("#undo-btn")).toBeEnabled();
    await page.locator("#end-btn").click();
  } else {
    await expect(page.locator(".finished")).toBeVisible();
    await check(page, `${name}-finished`, [page.locator("#done-btn")]);
    await page.locator("#done-btn").click();
  }
  await expect(page.locator(".deck-list-view")).toBeVisible();
}

/** The Inbox: a draft, the editor over it, a mid-swipe on a phone, and the end. */
async function inbox(page: Page, tag: string): Promise<void> {
  await page.locator("#inbox-btn").click();
  await expect(page.locator(".inbox .card")).toBeVisible();
  const controls = [
    page.locator("#inbox-back"),
    page.locator("#inbox-undo"),
    page.locator("#inbox-edit"),
    page.locator(".inbox .card"),
    page.locator("#discard-btn"),
    page.locator("#skip-btn"),
    page.locator("#keep-btn"),
  ];
  await check(page, `${tag}-inbox`, controls);
  await page.locator("#inbox-edit").click();
  await expect(page.locator(".editor-text")).toBeVisible();
  await check(page, `${tag}-inbox-editor`, [page.locator(".editor-save"), page.locator(".editor-cancel")]);
  await page.locator(".editor-cancel").click();
  await page.locator("#keep-btn").click();
  await expect(page.locator(".inbox .card-content")).toContainText("StatefulSet");
  if (await page.evaluate(() => "ontouchstart" in window)) {
    await midSwipe(page, `${tag}-inbox-swipe`, [page.locator("#keep-btn")]);
  }
  await check(page, `${tag}-inbox-cloze`, controls);
  await page.locator("#skip-btn").click();
  await expect(page.locator(".inbox-finished")).toBeVisible();
  await check(page, `${tag}-inbox-finished`, [page.locator("#inbox-done"), page.locator("#inbox-undo")]);
  await page.locator("#inbox-done").click();
  await expect(page.locator(".deck-list-view")).toBeVisible();
}

/** A finger held partway through a right swipe, then taken back: nothing graded. */
async function midSwipe(page: Page, name: string, controls?: Locator[]): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const box = (await page.locator(".card-container").boundingBox())!;
  const x = box.x + box.width / 3;
  const y = box.y + box.height / 2;
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", dx = 0) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: x + dx, y }],
    });
  await touch("touchStart");
  for (const dx of [10, 30, 60, 100]) await touch("touchMove", dx);
  await expect(page.locator(".swipe-hint")).toBeVisible();
  await check(page, name, [page.locator(".swipe-hint"), ...(controls ?? (await page.locator(".grade-btn").all()))]);
  for (const dx of [60, 20, 0]) await touch("touchMove", dx);
  await touch("touchEnd");
  await cdp.detach();
  await expect(page.locator(".swipe-hint")).toBeHidden();
}

async function tour(page: Page, github: FakeGitHub, tag: string): Promise<void> {
  seed(github);
  await page.goto("/");
  await expect(page.locator("#drill-all")).toBeVisible();

  await expect(page.locator("#deck-problems")).toBeVisible();
  await check(page, `${tag}-today`, [
    page.locator("#deck-problems summary"),
    page.locator("#drill-all"),
    page.locator("#new-card-btn"),
    page.locator("#stats-btn"),
    page.locator("#settings-btn"),
  ]);
  await check(page, `${tag}-today-full`, [page.locator(".deck-row").last(), page.locator("#inbox-btn")], true);

  await inbox(page, tag);

  await review(page, "Kubernetes", tag, "3");
  await review(page, "Rust", tag, "1");
  await review(page, "Networking", tag, "4");

  await page.locator("#stats-btn").click();
  await expect(page.locator(".stats-view")).toBeVisible();
  await check(page, `${tag}-stats`, [page.locator("#back-btn"), page.locator(".stat-box").last()]);
  await check(
    page,
    `${tag}-stats-full`,
    [page.locator("#forecast"), page.locator("#heatmap"), page.locator(".leeches")],
    true
  );
  await page.locator("#back-btn").click();

  await page.locator("#settings-btn").click();
  await expect(page.locator(".settings-view")).toBeVisible();
  await check(
    page,
    `${tag}-settings`,
    [
      page.locator("#back-btn"),
      page.locator("#sync-btn"),
      page.locator(".stepper"),
      page.locator("#desired-retention"),
      page.locator("#theme"),
      page.locator("#interval-fuzz"),
    ],
    true
  );
  await page.locator("#back-btn").click();
  await expect(page.locator(".deck-list-view")).toBeVisible();
}

/**
 * The welcome, signed out, and the demo it leads to: the bar above every
 * screen must not push the review's controls off the bottom.
 */
async function onboardingTour(page: Page, tag: string): Promise<void> {
  await new FakeGitHub({ owner: "someone", repo: "cards", branch: "main" }).install(page, {
    signedIn: false,
  });
  await page.goto("/");
  await expect(page.locator(".welcome-view")).toBeVisible();
  await check(
    page,
    `${tag}-welcome`,
    [
      page.locator("#settings-btn"),
      page.locator("#demo-btn"),
      page.locator("#template-link"),
      page.locator("#signin-btn"),
      page.locator("#existing-btn"),
    ],
    true
  );

  await page.locator("#demo-btn").click();
  await expect(page.locator("#drill-all")).toBeVisible();
  await check(page, `${tag}-demo-today`, [
    page.locator(".demo-bar"),
    page.locator("#demo-exit"),
    page.locator("#drill-all"),
    page.locator("#settings-btn"),
  ]);
  await page.locator("#drill-all").click();
  await check(page, `${tag}-demo-question`, [
    page.locator(".demo-bar"),
    page.locator("#end-btn"),
    page.locator("#reveal-btn"),
  ]);
  await page.locator("#reveal-btn").click();
  await check(page, `${tag}-demo-answer`, [
    page.locator(".demo-bar"),
    page.locator(".card-container .card"),
    ...(await page.locator(".grade-btn").all()),
  ]);
  await page.locator("#end-btn").click();
  await page.locator("#settings-btn").click();
  await check(page, `${tag}-demo-settings`, [page.locator("#demo-own"), page.locator("#theme")], true);
}

for (const project of Object.keys(WIDTHS)) {
  for (const width of WIDTHS[project]) {
    test.describe(`${width}px on ${project}`, () => {
      test.beforeEach(async ({ page }, info) => {
        test.skip(info.project.name !== project, `${width}px runs on the ${project} project`);
        await page.setViewportSize({ width, height: HEIGHT[width] });
      });

      for (const scheme of ["light", "dark"] as Scheme[]) {
        test(`every screen fits, ${scheme}`, async ({ page, github }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await tour(page, github, `${project}-${width}-${scheme}`);
          // The palette really is the one asked for, not a light page in a dark test.
          expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
            scheme === "dark" ? "rgb(17, 19, 23)" : "rgb(247, 247, 245)"
          );
        });
      }

      for (const scheme of ["light", "dark"] as Scheme[]) {
        test(`the welcome and the demo fit, ${scheme}`, async ({ page }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await onboardingTour(page, `${project}-${width}-${scheme}`);
        });
      }

      test("caught up, in a theme chosen over the system's", async ({ page, github }) => {
        seed(github);
        // No new cards today, and nothing reviewed yet: nothing left to do.
        await page.addInitScript(() => {
          localStorage.setItem("new_cards_per_day", "0");
          localStorage.setItem("theme", "dark");
        });
        await page.emulateMedia({ colorScheme: "light" });
        await page.goto("/");
        await expect(page.locator(".all-caught-up")).toBeVisible();
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
          "rgb(17, 19, 23)"
        );
        await check(page, `${project}-${width}-caught-up`, [
          page.locator(".coming-up"),
          page.locator("#settings-btn"),
        ]);
      });
    });
  }
}
