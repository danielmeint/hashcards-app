import { test, expect } from "./fake-github";

/**
 * The Inbox end to end: drafts across two files, two kept, one discarded, one
 * rewritten, and on leaving exactly one commit to main holding all of it.
 */

const K8S = `Q: What is a Pod?
A: The smallest deployable unit.

---

Status: draft
Q: What does a Deployment manage?
A: A ReplicaSet.

---

ID: k8s-svc
Status: draft
Tags: networking
C: A [Service] gives Pods a stable [address].
Extra: ClusterIP by default.
`;

const GEO = `---
name = "Capitals"
---

Status: draft
Q: Capital of Estonia?
A: Tallinn

---

Status: draft
Q: Capital of Latvia?
A: Riga
`;

test("keep two, discard one, edit one: one commit with all of it", async ({ page, github }) => {
  github.set("k8s.md", K8S);
  github.set("geo/Capitals.md", GEO);
  await page.goto("/");

  await expect(page.locator("#inbox-count")).toHaveText("4 drafts");
  await page.locator("#inbox-btn").click();
  await expect(page.locator(".inbox .card")).toBeVisible();

  // In file order: Estonia, Latvia (geo/), then Deployment, Service.
  await expect(page.locator(".inbox .card-content")).toContainText("Estonia");
  await page.locator("#keep-btn").click();
  await expect(page.locator(".inbox .card-content")).toContainText("Latvia");
  await page.keyboard.press("d");
  await expect(page.locator(".inbox .card-content")).toContainText("Deployment");

  // Undo brings Latvia back; discard it again.
  await page.keyboard.press("u");
  await expect(page.locator(".inbox .card-content")).toContainText("Latvia");
  await page.locator("#discard-btn").click();
  await expect(page.locator(".inbox .card-content")).toContainText("Deployment");
  await page.keyboard.press("k");

  // The Service cloze: rewritten, still a draft, so it stays on screen.
  await expect(page.locator(".inbox .card-content")).toContainText("Service");
  await page.locator("#inbox-edit").click();
  const box = page.locator(".editor-text");
  await expect(box).toHaveValue(/Status: draft/);
  await box.fill(
    "Status: draft\nTags: networking\nC: A [Service] gives a set of Pods one stable [address].\nExtra: ClusterIP by default."
  );
  await page.locator(".editor-save").click();
  await expect(page.locator(".editor-backdrop")).toHaveCount(0);
  await expect(page.locator(".inbox .card-content")).toContainText("a set of Pods");

  // Nothing has been committed yet.
  expect(github.mainCommits).toEqual([]);
  await page.locator("#inbox-back").click();
  await expect(page.locator(".deck-list-view")).toBeVisible();

  await expect.poll(() => github.mainCommits).toEqual(["Inbox: keep 2, discard 1, edit 1"]);
  const text = (path: string) => String(github.files.get(path)!.content);
  const geo = text("geo/Capitals.md");
  expect(geo).toMatch(/^---\nname = "Capitals"\n---\n\nID: [0-9a-z]{8}\nQ: Capital of Estonia\?\nA: Tallinn\n$/);
  const k8s = text("k8s.md");
  expect(k8s).toMatch(/^Q: What is a Pod\?\nA: The smallest deployable unit\.\n\n---\n\nID: [0-9a-z]{8}\nQ: What does a Deployment manage\?\nA: A ReplicaSet\.\n\n---\n\n/);
  expect(k8s.endsWith(
    "ID: k8s-svc\nStatus: draft\nTags: networking\nC: A [Service] gives a set of Pods one stable [address].\nExtra: ClusterIP by default.\n"
  )).toBe(true);

  // The edited draft is still waiting; the two kept are new cards.
  await expect(page.locator("#inbox-count")).toHaveText("1 draft");
  await expect(page.locator("#due-summary")).toContainText("3 new");
  expect(github.unhandled).toEqual([]);
});

test("decisions made offline wait, and land on reconnecting", async ({ page, github, context }) => {
  github.set("geo/Capitals.md", GEO);
  await page.goto("/");
  await expect(page.locator("#inbox-count")).toHaveText("2 drafts");

  await page.locator("#inbox-btn").click();
  await expect(page.locator(".inbox .card-content")).toContainText("Estonia");
  // Only now: the dev server is the network too, and the Inbox loads its
  // Markdown renderer from it on the way in (the service worker caches it in
  // a real install).
  await context.setOffline(true);
  await page.keyboard.press("k");
  await expect(page.locator(".inbox .card-content")).toContainText("Latvia");
  await page.keyboard.press("s");
  await expect(page.locator(".inbox-finished")).toBeVisible();
  await page.locator("#inbox-done").click();

  await expect(page.locator("#sync-status-text")).toHaveText(
    "Offline — 1 Inbox change will sync when you reconnect."
  );
  expect(github.mainCommits).toEqual([]);

  await context.setOffline(false);
  await expect.poll(() => github.mainCommits).toEqual(["Inbox: keep 1"]);
  await expect(page.locator("#sync-status")).toBeHidden();
});
