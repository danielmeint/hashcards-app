import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./data-branch";

describe("gitBlobSha", () => {
  it("is git's name for the content", async () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // Bytes, not characters: `printf 'é\n' | git hash-object --stdin`
    expect(await gitBlobSha("é\n")).toBe(
      (await import("node:child_process")).execFileSync("git", ["hash-object", "--stdin"], { input: "é\n" }).toString().trim()
    );
  });
});
