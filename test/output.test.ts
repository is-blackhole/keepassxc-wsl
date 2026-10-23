import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatVariables, escapeEnvValue, escapeShellValue, writeFileAtomic } from "../src/output.js";

describe("env format", () => {
  it("escapes quotes, backslash, dollar and newlines", () => {
    const value = 'a"b\\c$HOME\nline2\r';
    expect(formatVariables([["KEY", value]], "env")).toBe('KEY="a\\"b\\\\c\\$HOME\\nline2\\r"\n');
    expect(escapeEnvValue(value)).toBe('a\\"b\\\\c\\$HOME\\nline2\\r');
  });

  it("keeps unicode as is", () => {
    expect(formatVariables([["GREETING", "pässwörd 🔑"]], "env")).toBe('GREETING="pässwörd 🔑"\n');
  });
});

describe("shell format", () => {
  it("escapes single quotes for eval", () => {
    expect(escapeShellValue("it's")).toBe("'it'\\''s'");
    expect(formatVariables([["KEY", "it's $HOME"]], "shell")).toBe("export KEY='it'\\''s $HOME'\n");
  });

  it("leaves dollar and backslash untouched inside single quotes", () => {
    expect(formatVariables([["KEY", "a$b\\c\"d"]], "shell")).toBe("export KEY='a$b\\c\"d'\n");
  });

  it("keeps newlines inside the quotes", () => {
    expect(formatVariables([["KEY", "a\nb"]], "shell")).toBe("export KEY='a\nb'\n");
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
