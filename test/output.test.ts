import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatVariables, writeFileAtomic } from "../src/output.js";

describe("env format", () => {
  it.each([
    "",
    'a"b',
    "it's",
    "a\\b",
    "$HOME ${SECRET}",
    "line1\nline2",
    "literal\\n and \\r",
    "'\"both quotes\nNEXT=not-an-assignment",
    "all '\"` quotes",
    "  # comment-like value  ",
    "`printf injected`",
    "pässwörd 🔑",
  ])("round-trips %j through the Node.js dotenv parser", (value) => {
    const text = formatVariables([["KEY", value], ["NEXT", "unchanged"]], "env");
    expect(parseEnv(text)).toEqual({ KEY: value, NEXT: "unchanged" });
  });

  it.each(["a\rb", "all '\"` quotes\nand a newline"])('rejects unrepresentable values without leaking them', (value) => {
    const format = (): string => formatVariables([["FIRST", "secret"], ["KEY", value]], "env");
    expect(format).toThrow("cannot be represented losslessly");
    try {
      format();
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
      expect((error as Error).message).not.toContain("secret");
    }
  });

  it("keeps unicode as is", () => {
    expect(formatVariables([["GREETING", "pässwörd 🔑"]], "env")).toBe('GREETING="pässwörd 🔑"\n');
  });
});

describe("json format", () => {
  it("outputs an object with the original values", () => {
    expect(JSON.parse(formatVariables([["A", 'x"$\n']], "json"))).toEqual({ A: 'x"$\n' });
  });
});

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kpx-out-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the file with mode 600 by default and leaves no tmp file", async () => {
    const path = join(dir, ".env");
    await writeFileAtomic(path, "A=1\n");

    expect(await readFile(path, "utf8")).toBe("A=1\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual([".env"]);
  });

  it("replaces an existing file entirely", async () => {
    const path = join(dir, "out");
    await writeFileAtomic(path, "old content that is longer");
    await writeFileAtomic(path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
  });
});
