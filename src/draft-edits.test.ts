import { describe, it, expect } from "vitest";
import {
  applyOps,
  discardBlock,
  findDrafts,
  keepDraft,
  locateBlock,
  rewriteBlock,
} from "./draft-edits";
import { parseFile } from "./parser";
import { Card } from "./types";

const FILE = `---
name = "Kubernetes"
---

ID: k8s-pod
Q: What is a Pod?
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

---

Q: What is a Node?
A: A worker machine.
`;

async function cards(text: string, path = "k8s.md", repo = "me/cards"): Promise<Card[]> {
  return (await parseFile(text, path, "k8s")).map((c) => ({ ...c, repo }));
}

async function rangeOf(text: string, question: string): Promise<[number, number]> {
  const card = (await cards(text)).find(
    (c) => (c.content.type === "basic" ? c.content.question : c.content.text).includes(question)
  )!;
  return card.range;
}

describe("findDrafts", () => {
  it("groups a block's cards and skips active ones", async () => {
    const drafts = findDrafts(await cards(FILE), () => true);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].cards).toHaveLength(1);
    // A cloze with two deletions is one draft, not two.
    expect(drafts[1].cards).toHaveLength(2);
    expect(drafts[1].cards.every((c) => c.id === "k8s-svc")).toBe(true);
  });

  it("keeps a reverse card with its forward card", async () => {
    const text = "Status: draft\nReverse: yes\nQ: Estonia\nA: Tallinn\n";
    const [draft] = findDrafts(await cards(text), () => true);
    expect(draft.cards.map((c) => c.content.type === "basic" && c.content.question)).toEqual([
      "Estonia",
      "Tallinn",
    ]);
  });

  it("leaves out collections that cannot be written to", async () => {
    const mine = await cards(FILE, "k8s.md", "me/cards");
    const theirs = await cards(FILE, "k8s.md", "them/deck");
    const drafts = findDrafts([...mine, ...theirs], (repo) => repo === "me/cards");
    expect(drafts.map((d) => d.repo)).toEqual(["me/cards", "me/cards"]);
  });
});

describe("keepDraft", () => {
  it("swaps the Status line for an ID on a block without one", async () => {
    const out = keepDraft(FILE, await rangeOf(FILE, "Deployment"), "abcd2345");
    expect(out).toBe(FILE.replace("Status: draft\nQ: What does", "ID: abcd2345\nQ: What does"));
  });

  it("only drops the Status line when the block has an ID", async () => {
    const out = keepDraft(FILE, await rangeOf(FILE, "Service"), "unused00");
    expect(out).toBe(FILE.replace("ID: k8s-svc\nStatus: draft\n", "ID: k8s-svc\n"));
    const kept = (await cards(out)).filter((c) => c.id === "k8s-svc");
    expect(kept.map((c) => c.status)).toEqual(["active", "active"]);
    expect(kept.map((c) => c.key)).toEqual(["k8s-svc:1", "k8s-svc:2"]);
  });

  it("keeps CRLF line endings", () => {
    const text = "Status: draft\r\nQ: a\r\nA: b\r\n";
    expect(keepDraft(text, [1, 3], "abcd2345")).toBe("ID: abcd2345\r\nQ: a\r\nA: b\r\n");
  });

  it("refuses a block that is not a draft", () => {
    expect(() => keepDraft("Q: a\nA: b\n", [1, 2], "abcd2345")).toThrow(/Status: draft/);
  });

  it("does not mistake an answer saying Status: draft for metadata", () => {
    const text = "Status: draft\nQ: Which line?\nA: Status: draft\n";
    expect(keepDraft(text, [1, 3], "abcd2345")).toBe("ID: abcd2345\nQ: Which line?\nA: Status: draft\n");
  });
});

describe("discardBlock", () => {
  it("takes the separator after a block in the middle", async () => {
    const out = discardBlock(FILE, await rangeOf(FILE, "Deployment"));
    expect(out).toBe(FILE.replace("Status: draft\nQ: What does a Deployment manage?\nA: A ReplicaSet.\n\n---\n\n", ""));
  });

  it("takes the separator before the last block, keeping the trailing newline", async () => {
    const text = "Q: a\nA: b\n\n---\n\nStatus: draft\nQ: c\nA: d\n";
    expect(discardBlock(text, await rangeOf(text, "c"))).toBe("Q: a\nA: b\n");
  });

  it("removes the only card, leaving the frontmatter alone", () => {
    const text = '---\nname = "x"\n---\n\nStatus: draft\nQ: c\nA: d\n';
    expect(discardBlock(text, [5, 7])).toBe('---\nname = "x"\n---\n\n');
  });

  it("never takes the frontmatter's closing line for a separator", async () => {
    const text = '---\nname = "x"\n---\nStatus: draft\nQ: c\nA: d\n';
    expect(discardBlock(text, [4, 6])).toBe('---\nname = "x"\n---\n');
  });

  it("removes a block ended by the next card's tag", async () => {
    const text = "Status: draft\nQ: a\nA: b\n\nQ: c\nA: d\n";
    const out = discardBlock(text, [1, 3]);
    expect(out).toBe("Q: c\nA: d\n");
  });

  it("leaves every other byte of the file as it was", async () => {
    const out = discardBlock(FILE, await rangeOf(FILE, "Service"));
    const before = await cards(FILE);
    const after = await cards(out);
    expect(after.map((c) => c.key)).toEqual(
      before.filter((c) => c.id !== "k8s-svc").map((c) => c.key)
    );
    expect(out.startsWith(FILE.slice(0, FILE.indexOf("ID: k8s-svc")))).toBe(true);
    expect(out.endsWith("Q: What is a Node?\nA: A worker machine.\n")).toBe(true);
  });
});

describe("rewriteBlock", () => {
  it("keeps the ID the rewrite dropped", async () => {
    const range = await rangeOf(FILE, "Service");
    const out = rewriteBlock(FILE, range, "Status: draft\nC: A [Service] is stable.");
    expect(out).toContain("ID: k8s-svc\nStatus: draft\nC: A [Service] is stable.\n\n---");
  });

  it("is a discard when emptied", async () => {
    const range = await rangeOf(FILE, "Deployment");
    expect(rewriteBlock(FILE, range, "  ")).toBe(discardBlock(FILE, range));
  });
});

describe("locateBlock", () => {
  it("finds a draft after the file moved around it", async () => {
    const [, svc] = findDrafts(await cards(FILE), () => true);
    const moved = "Q: New card on top\nA: yes\n\n---\n\n" + FILE.slice(FILE.indexOf("ID: k8s-pod"));
    const at = await locateBlock(moved, "k8s.md", svc.cards.map((c) => c.hash));
    expect(at?.cards.map((c) => c.id)).toEqual(["k8s-svc", "k8s-svc"]);
  });

  it("refuses a block someone already kept", async () => {
    const [draft] = findDrafts(await cards(FILE), () => true);
    const kept = FILE.replace("Status: draft\nQ: What does", "Q: What does");
    expect(await locateBlock(kept, "k8s.md", [draft.cards[0].hash])).toBeNull();
  });
});

describe("applyOps", () => {
  it("applies several changes to one file, each finding its block afresh", async () => {
    const [deploy, svc] = findDrafts(await cards(FILE), () => true);
    const result = await applyOps(FILE, "k8s.md", [
      { action: "discard" as const, block: deploy.cards.map((c) => c.hash) },
      { action: "keep" as const, block: svc.cards.map((c) => c.hash), stampId: "zzzz0000" },
    ]);
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toHaveLength(2);
    expect(result.text).toBe(
      FILE.replace("Status: draft\nQ: What does a Deployment manage?\nA: A ReplicaSet.\n\n---\n\n", "").replace(
        "ID: k8s-svc\nStatus: draft\n",
        "ID: k8s-svc\n"
      )
    );
  });

  it("reports a change whose draft was edited upstream as a conflict, and applies the rest", async () => {
    const [deploy, svc] = findDrafts(await cards(FILE), () => true);
    const upstream = FILE.replace("A: A ReplicaSet.", "A: A ReplicaSet, which manages Pods.");
    const keep = { action: "keep" as const, block: deploy.cards.map((c) => c.hash), stampId: "abcd2345" };
    const discard = { action: "discard" as const, block: svc.cards.map((c) => c.hash) };
    const result = await applyOps(upstream, "k8s.md", [keep, discard]);
    expect(result.conflicts).toEqual([keep]);
    expect(result.applied).toEqual([discard]);
    expect(result.text).toContain("A: A ReplicaSet, which manages Pods.");
    expect(result.text).toContain("Status: draft");
    expect(result.text).not.toContain("k8s-svc");
  });

  it("refuses a rewrite that no longer parses", async () => {
    const [deploy] = findDrafts(await cards(FILE), () => true);
    const result = await applyOps(FILE, "k8s.md", [
      { action: "edit" as const, block: deploy.cards.map((c) => c.hash), text: "Status: draft\nQ: no answer" },
    ]);
    expect(result.applied).toEqual([]);
    expect(result.text).toBe(FILE);
  });

  it("follows an edit with a keep of the edited block", async () => {
    const [deploy] = findDrafts(await cards(FILE), () => true);
    const edited = "Status: draft\nQ: What does a Deployment own?\nA: ReplicaSets.";
    const afterEdit = await applyOps(FILE, "k8s.md", [
      { action: "edit" as const, block: deploy.cards.map((c) => c.hash), text: edited },
    ]);
    const editedHash = (await cards(afterEdit.text)).find((c) => c.status === "draft" && c.content.type === "basic")!.hash;
    const both = await applyOps(FILE, "k8s.md", [
      { action: "edit" as const, block: deploy.cards.map((c) => c.hash), text: edited },
      { action: "keep" as const, block: [editedHash], stampId: "own2rs00" },
    ]);
    expect(both.conflicts).toEqual([]);
    expect(both.text).toContain("ID: own2rs00\nQ: What does a Deployment own?\nA: ReplicaSets.\n");
  });
});
