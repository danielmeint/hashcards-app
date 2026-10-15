import { describe, it, expect } from "vitest";
import { createInboxSession, InboxDeps } from "./inbox-session";
import { DraftBlock } from "../draft-edits";
import { InboxOp } from "../inbox-queue";
import { Card } from "../types";

function block(name: string, id: string | null = null): DraftBlock {
  const card = {
    deckName: "d",
    repo: "me/cards",
    filePath: "d.md",
    range: [1, 3],
    content: { type: "basic", question: name, answer: "a" },
    hash: `hash-${name}`,
    familyHash: null,
    id,
    key: id ?? `h:${name}`,
    tags: [],
    status: "draft",
  } as Card;
  return { repo: "me/cards", path: "d.md", cards: [card] };
}

function harness(drafts: DraftBlock[]) {
  const queued: InboxOp[] = [];
  let n = 0;
  const deps: InboxDeps = {
    enqueue: async (ops) => void queued.push(...ops),
    drop: async (ids) => {
      for (const id of ids) queued.splice(queued.findIndex((o) => o.id === id), 1);
    },
    newCardId: () => `card${++n}xx`,
    newOpId: () => `op-${++n}`,
    now: () => "2026-10-15T10:00:00.000Z",
  };
  return { session: createInboxSession(drafts, deps), queued };
}

describe("an Inbox visit", () => {
  it("queues a keep with a stamped ID only for a block without one", async () => {
    const { session, queued } = harness([block("a"), block("b", "has-id")]);
    await session.keep();
    await session.keep();
    expect(queued.map((o) => [o.action, o.stampId])).toEqual([
      ["keep", "card1xx"],
      ["keep", undefined],
    ]);
    expect(session.finished).toBe(true);
  });

  it("undoes the last decision, taking its op back out of the queue", async () => {
    const { session, queued } = harness([block("a"), block("b")]);
    await session.discard();
    expect(session.current?.cards[0].hash).toBe("hash-b");
    await session.undo();
    expect(queued).toEqual([]);
    expect(session.current?.cards[0].hash).toBe("hash-a");
    expect(session.counts().discard).toBe(0);
  });

  it("skips without queueing anything, and an undo brings the draft back", async () => {
    const { session, queued } = harness([block("a"), block("b")]);
    session.skip();
    await Promise.resolve();
    expect(queued).toEqual([]);
    expect(session.current?.cards[0].hash).toBe("hash-b");
    await session.undo();
    expect(session.current?.cards[0].hash).toBe("hash-a");
  });

  it("keeps an edited draft on screen, and an undo restores the original", async () => {
    const { session, queued } = harness([block("a")]);
    const edited = block("a2");
    const op = { id: "edit-1", repo: "me/cards", path: "d.md", action: "edit", block: ["hash-a"], at: "" } as InboxOp;
    await session.edit(op, edited);
    expect(session.current).toBe(edited);
    expect(queued).toEqual([op]);
    await session.undo();
    expect(session.current?.cards[0].hash).toBe("hash-a");
    expect(queued).toEqual([]);
  });

  it("moves on from an edit that took the Status line out", async () => {
    const { session } = harness([block("a"), block("b")]);
    const kept = block("a2");
    kept.cards[0] = { ...kept.cards[0], status: "active" };
    await session.edit({ id: "e", action: "edit" } as InboxOp, kept);
    expect(session.current?.cards[0].hash).toBe("hash-b");
  });

  it("takes one decision at a time, so a double tap can't decide the next card", async () => {
    const { session, queued } = harness([block("a"), block("b")]);
    await Promise.all([session.keep(), session.keep(), session.skip()]);
    expect(queued).toHaveLength(1);
    expect(session.current?.cards[0].hash).toBe("hash-b");
  });

  it("can't undo what has been committed, but still counts it", async () => {
    const { session, queued } = harness([block("a"), block("b"), block("c")]);
    await session.keep();
    await session.discard();
    // The first was committed; the second is still queued.
    session.committed(new Set([queued[1].id]));
    expect(session.canUndo).toBe(true);
    await session.undo();
    expect(session.canUndo).toBe(false);
    expect(session.counts()).toEqual({ keep: 1, discard: 0, edit: 0, skip: 0 });
  });
});
