import { afterEach, describe, expect, it, vi } from "vitest";
import { exitCodeFor, formatEntryMetas, main, runChild } from "../src/cli.js";
import { EXIT, KpxError } from "../src/errors.js";
import { createLogger } from "../src/output.js";

function captureWrites(): {
  stdout: string[];
  stderr: string[];
  restore: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  return {
    stdout,
    stderr,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("main", () => {
  it("prints help and exits 0 with --help", async () => {
    const io = captureWrites();
    const code = await main(["--help"]);
    expect(code).toBe(EXIT.OK);
    expect(io.stdout.join("")).toContain("Usage:");
    expect(io.stderr).toEqual([]);
  });

  it("prints help and exits 1 with no command", async () => {
    const io = captureWrites();
    const code = await main([]);
    expect(code).toBe(EXIT.FAILURE);
    expect(io.stdout.join("")).toContain("Usage:");
    expect(io.stderr).toEqual([]);
  });

  it("reports unknown command as usage error", async () => {
    const io = captureWrites();
    const code = await main(["nope"]);
    expect(code).toBe(EXIT.FAILURE);
    expect(io.stderr.join("")).toContain("unknown command: nope");
  });

  it("reports unsupported option for a command", async () => {
    const io = captureWrites();
    const code = await main(["list", "--field", "x"]);
    expect(code).toBe(EXIT.FAILURE);
    expect(io.stderr.join("")).toContain("list: unsupported option --field");
  });

  it("reports missing url for get", async () => {
    const io = captureWrites();
    const code = await main(["get"]);
    expect(code).toBe(EXIT.FAILURE);
    expect(io.stderr.join("")).toContain("missing argument: url");
  });

  it("reports missing command after -- for run", async () => {
    const io = captureWrites();
    const code = await main(["run", "http://example.test"]);
    expect(code).toBe(EXIT.FAILURE);
    expect(io.stderr.join("")).toContain("specify a command after --");
  });

  it("reports invalid format for env", async () => {
    const io = captureWrites();
    const code = await main(["env", "http://example.test", "--format", "xml"]);
    expect(code).toBe(EXIT.FAILURE);
    expect(io.stderr.join("")).toContain("unknown format: xml");
  });
});

describe("exitCodeFor", () => {
  it("maps synthetic KpxError exit codes", () => {
    expect(exitCodeFor(new KpxError("nf", EXIT.NOT_FOUND))).toBe(2);
    expect(exitCodeFor(new KpxError("amb", EXIT.AMBIGUOUS))).toBe(3);
    expect(exitCodeFor(new KpxError("lock", EXIT.LOCKED))).toBe(4);
    expect(exitCodeFor(new KpxError("rej", EXIT.ASSOC_REJECTED))).toBe(5);
  });

  it("falls back to general failure for unknown errors", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(EXIT.FAILURE);
  });
});

describe("formatEntryMetas", () => {
  const metas = [
    { name: "Alpha", uuid: "u1", url: "https://a.test" },
    { name: "Beta", uuid: "u2", url: "https://b.test/path" },
  ];

  it("formats entries as tab-separated lines", () => {
    expect(formatEntryMetas(metas)).toBe("https://a.test\tAlpha\tu1\nhttps://b.test/path\tBeta\tu2\n");
  });

  it("filters by fragment", () => {
    expect(formatEntryMetas(metas, "b.test")).toBe("https://b.test/path\tBeta\tu2\n");
  });

  it("returns empty output for empty list", () => {
    expect(formatEntryMetas([], "")).toBe("");
  });
});

describe("runChild", () => {
  it("passes environment variables and returns child exit code", async () => {
    const logger = createLogger(true);
    const code = await runChild(
      process.execPath,
      ["-e", "process.exit(process.env.KPX_TEST === 'value' ? 7 : 1)"],
      { KPX_TEST: "value" },
      { ...process.env, KPX_TEST: "parent" },
      logger,
    );
    expect(code).toBe(7);
  });

  it("reports start errors and returns failure", async () => {
    const messages: string[] = [];
    const logger = createLogger(false, (text) => messages.push(text));
    const code = await runChild("/definitely/not/a/real/kpx-command", [], {}, {}, logger);
    expect(code).toBe(EXIT.FAILURE);
    expect(messages.join("")).toContain("failed to start");
  });
});
