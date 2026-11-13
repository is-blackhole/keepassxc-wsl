import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock } = vi.hoisted(() => ({ connectMock: vi.fn() }));

vi.mock("../src/client.js", () => ({ connect: connectMock }));

import { main } from "../src/cli.js";
import { EXIT } from "../src/errors.js";

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

function fakeSession(databaseHash: string | undefined, associated: boolean): Record<string, unknown> {
  return {
    version: "2.8.0",
    databaseHash,
    associated,
    close: vi.fn(),
  };
}

describe("status", () => {
  let dir: string;
  let proxyPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kpx-status-"));
    proxyPath = join(dir, "keepassxc-proxy.exe");
    await writeFile(proxyPath, "");
    connectMock.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("reports an unknown association when the database is locked", async () => {
    connectMock.mockResolvedValue(fakeSession(undefined, false));
    const io = captureStdout();

    const code = await main(["status"], { KPX_PROXY: proxyPath });

    const output = io.chunks.join("");
    expect(code).toBe(EXIT.FAILURE);
    expect(output).toContain("database: locked");
    expect(output).toContain("association: unknown (database locked)");
    expect(output).not.toContain("association: none");
    expect(connectMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowUnlock: false, allowAssociate: false }),
    );
  });

  it("reports a valid association when the database is open", async () => {
    connectMock.mockResolvedValue(fakeSession("db-hash", true));
    const io = captureStdout();

    const code = await main(["status"], { KPX_PROXY: proxyPath });

    const output = io.chunks.join("");
    expect(code).toBe(EXIT.OK);
    expect(output).toContain("database: open");
    expect(output).toContain("association: valid");
  });

  it("reports none when the database is open without an association", async () => {
    connectMock.mockResolvedValue(fakeSession("db-hash", false));
    const io = captureStdout();

    const code = await main(["status"], { KPX_PROXY: proxyPath });

    const output = io.chunks.join("");
    expect(code).toBe(EXIT.FAILURE);
    expect(output).toContain("database: open");
    expect(output).toContain("association: none");
  });
});
