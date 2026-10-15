import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hc, makeRepo } from "./test-helpers";

describe("hc", () => {
  it("lists commands on --help and exits 2 with no command", async () => {
    const help = await hc(["--help"]);
    expect(help.code).toBe(0);
    for (const name of ["lint", "add", "due", "stats", "leeches", "show", "init", "migrate", "import", "fit"]) {
      expect(help.stdout).toMatch(new RegExp(`^  ${name} `, "m"));
    }
    expect((await hc([])).code).toBe(2);
  });

  it("prints a command's help", async () => {
    const run = await hc(["add", "--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("hc add --json <file|->");
    expect(run.stdout).toContain("--repo <dir>");
  });

  it("exits 2 on unknown commands, unknown options and stray arguments", async () => {
    const repo = makeRepo();
    expect((await hc(["frobnicate"])).code).toBe(2);
    const bad = await hc(["lint", "--frob", "--repo", repo]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/Unknown option '--frob'.*hc lint --help/);
    expect((await hc(["lint", "extra", "--repo", repo])).code).toBe(2);
    expect((await hc(["lint", "--repo", "/no/such/dir"])).code).toBe(2);
  });

  it("answers a usage error in JSON when JSON was asked for", async () => {
    const run = await hc(["due", "--json", "--date", "someday", "--repo", makeRepo()]);
    expect(run.code).toBe(2);
    expect(run.json()).toEqual({ ok: false, error: expect.stringContaining("--date") });
  });

  it("runs from source with plain node", () => {
    const repo = makeRepo({ "a.md": "ID: one\nQ: q\nA: a\n" });
    const entry = fileURLToPath(new URL("./hc.ts", import.meta.url));
    const out = execFileSync(process.execPath, [entry, "lint", "--json", "--repo", repo], { encoding: "utf8" });
    expect(JSON.parse(out)).toMatchObject({ ok: true, files: 1, cards: 1 });
    const failing = spawnSync(process.execPath, [entry, "show", "nope", "--repo", repo], { encoding: "utf8" });
    expect(failing.status).toBe(1);
  });
});
