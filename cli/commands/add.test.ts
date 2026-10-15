import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFile } from "../../src/parser";
import { hc, makeRepo, read } from "../test-helpers";

describe("hc add", () => {
  it("appends a basic card after a separator, with a fresh ID", async () => {
    const repo = makeRepo({ "net.md": "---\nname = \"Net\"\n---\n\nID: old\nQ: a\nA: b\n\n\n" });
    const run = await hc(["add", "--repo", repo, "--deck", "net.md", "-q", "Port of SSH?", "-a", "22", "--tags", "ssh, ports"]);
    expect(run.code).toBe(0);
    const text = read(repo, "net.md");
    expect(text).toMatch(/^---\nname = "Net"\n---\n\nID: old\nQ: a\nA: b\n\n---\n\nID: ([0-9a-z]{8})\nTags: ssh, ports\nQ: Port of SSH\?\nA: 22\n$/);
    expect(run.stdout).toMatch(/added [0-9a-z]{8} \(active\) net\.md:11/);
    const cards = await parseFile(text, "net.md", "net");
    expect(cards.map((c) => c.tags)).toEqual([[], ["ssh", "ports"]]);
  });

  it("creates a missing deck with frontmatter, and writes cloze, reverse and draft", async () => {
    const repo = makeRepo();
    const a = await hc(["add", "--repo", repo, "--deck", "net/tcp.md", "--name", "TCP", "--cloze", "TCP opens with [SYN].", "--draft", "--id", "tcp-syn"]);
    expect(a.code).toBe(0);
    const b = await hc(["add", "--repo", repo, "--deck", "net/tcp.md", "-q", "TCP", "-a", "Transmission Control Protocol", "--reverse"]);
    expect(b.code).toBe(0);
    const text = read(repo, "net/tcp.md");
    expect(text).toMatch(/^---\nname = "TCP"\n---\n\nID: tcp-syn\nStatus: draft\nC: TCP opens with \[SYN\]\.\n\n---\n\nID: \w{8}\nReverse: yes\nQ: TCP\nA: Transmission Control Protocol\n$/);
    const cards = await parseFile(text, "net/tcp.md", "tcp");
    expect(cards.map((c) => [c.deckName, c.status])).toEqual([["TCP", "draft"], ["TCP", "active"], ["TCP", "active"]]);
  });

  it("adds a JSON batch from stdin, answering in JSON", async () => {
    const repo = makeRepo();
    const batch = [
      { file: "a.md", type: "basic", question: "1?", answer: "1", id: "one" },
      { type: "cloze", text: "[two] and [three]", status: "suspended" },
    ];
    const run = await hc(["add", "--repo", repo, "--json", "-", "--deck", "b.md"], { stdin: JSON.stringify(batch) });
    expect(run.code).toBe(0);
    const out = run.json();
    expect(out).toMatchObject({ ok: true, dryRun: false, created: ["a.md", "b.md"] });
    expect(out.added[0]).toEqual({ id: "one", keys: ["one"], file: "a.md", line: 5, status: "active" });
    expect(out.added[1]).toMatchObject({ file: "b.md", status: "suspended" });
    expect(out.added[1].keys).toEqual([`${out.added[1].id}:1`, `${out.added[1].id}:2`]);
  });

  it("reads a JSON file relative to the working directory", async () => {
    const repo = makeRepo({ "in/cards.json": JSON.stringify({ file: "a.md", type: "basic", question: "q", answer: "a" }) });
    const run = await hc(["add", "--json", "in/cards.json"], { cwd: repo });
    expect(run.code).toBe(0);
    expect(read(repo, "a.md")).toContain("Q: q\nA: a\n");
  });

  it("validates every card and writes nothing if any is wrong", async () => {
    const repo = makeRepo({ "a.md": "ID: taken\nQ: x\nA: y\n" });
    const batch = [
      { file: "a.md", type: "basic", question: "fine", answer: "fine" },
      { file: "a.md", type: "basic", question: "no answer" },
      { file: "a.md", type: "cloze", text: "x [y]", question: "?" },
      { file: "a.md", type: "basic", question: "q", answer: "a", id: "taken" },
    ];
    const run = await hc(["add", "--repo", repo, "--json", "-"], { stdin: JSON.stringify(batch) });
    expect(run.code).toBe(2);
    expect(run.json()).toEqual({
      ok: false,
      errors: [
        { card: 1, path: "(card)", message: 'is missing "answer"' },
        { card: 2, path: "(card)", message: 'must not have "question" on a cloze card' },
      ],
    });
    expect(read(repo, "a.md")).toBe("ID: taken\nQ: x\nA: y\n");

    // Schema-valid, but the ID is already used.
    const dup = await hc(["add", "--repo", repo, "--json", "-"], { stdin: JSON.stringify(batch[3]) });
    expect(dup.json().errors).toEqual([{ card: 0, path: "/id", message: "ID 'taken' is already used at a.md:1" }]);
    const twice = [{ ...batch[0], id: "same" }, { ...batch[0], question: "other", id: "same" }];
    const inBatch = await hc(["add", "--repo", repo, "--json", "-"], { stdin: JSON.stringify(twice) });
    expect(inBatch.json().errors).toEqual([{ card: 1, path: "/id", message: "ID 'same' appears twice in this batch" }]);
    expect(read(repo, "a.md")).toBe("ID: taken\nQ: x\nA: y\n");
  });

  it("refuses bad JSON, files that are not decks, and broken decks", async () => {
    const repo = makeRepo({ "broken.md": "A: x\n" });
    const bad = await hc(["add", "--repo", repo, "--json", "-"], { stdin: "{nope" });
    expect(bad.code).toBe(2);
    expect(bad.json().errors[0].message).toMatch(/not valid JSON/);

    const readme = await hc(["add", "--repo", repo, "--deck", "README.md", "-q", "q", "-a", "a"]);
    expect(readme.code).toBe(2);
    expect(readme.stderr).toMatch(/README\.md is not a deck file/);
    expect(existsSync(join(repo, "README.md"))).toBe(false);

    const broken = await hc(["add", "--repo", repo, "--deck", "broken.md", "-q", "q", "-a", "a"]);
    expect(broken.stderr).toMatch(/broken\.md does not parse/);
  });

  it("rejects contradictory flags as usage errors", async () => {
    const repo = makeRepo();
    expect((await hc(["add", "--repo", repo, "-q", "q", "-a", "a"])).stderr).toMatch(/--deck is required/);
    expect((await hc(["add", "--repo", repo, "--deck", "a.md", "-q", "q", "--cloze", "[x]"])).code).toBe(2);
    expect((await hc(["add", "--repo", repo, "--deck", "a.md", "--cloze", "[x]", "--draft", "--active"])).code).toBe(2);
  });

  it("defaults to draft when an agent runs it, unless told otherwise", async () => {
    const repo = makeRepo();
    const args = ["add", "--repo", repo, "--deck", "a.md"];
    await hc([...args, "--cloze", "[agent]"], { env: { CLAUDECODE: "1" } });
    await hc([...args, "--cloze", "[agent active]", "--active"], { env: { CLAUDECODE: "1" } });
    await hc([...args, "--cloze", "[person]"]);
    await hc([...args, "--cloze", "[opted out]"], { env: { CLAUDECODE: "1", HC_AGENT: "0" } });
    const cards = await parseFile(read(repo, "a.md"), "a.md", "a");
    expect(cards.map((c) => c.status)).toEqual(["draft", "active", "active", "active"]);
  });

  it("writes nothing on --dry-run", async () => {
    const repo = makeRepo();
    const run = await hc(["add", "--repo", repo, "--deck", "a.md", "--cloze", "[x]", "--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("would add");
    expect(existsSync(join(repo, "a.md"))).toBe(false);
  });

  it("refuses a card whose text is already in the file", async () => {
    const repo = makeRepo({ "a.md": "ID: one\nQ: q\nA: a\n" });
    const run = await hc(["add", "--repo", repo, "--deck", "a.md", "-q", "q", "-a", "a"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/already has a card with exactly this text/);
  });
});
