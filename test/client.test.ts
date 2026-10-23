import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../src/client.js";
import { KpxError } from "../src/errors.js";
import { type Logger } from "../src/output.js";
import { FakeKeePass, type FakeEntry, type FakeOptions } from "./fake-keepass.js";

const entries: FakeEntry[] = [
  {
    name: "Players",
    login: "admin",
    password: "s3cret$\"'",
    uuid: "uuid-1",
    group: "Work",
    url: "http://loto.dev/players",
    expired: true,
    stringFields: { API_KEY: "key-1", DB_URL: "postgres://x" },
    totp: "123456",
  },
];

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const write = (text: string): void => {
    lines.push(text);
  };
  return {
    lines,
    logger: {
      info: (message) => write(`info: ${message}\n`),
      warn: (message) => write(`warn: ${message}\n`),
      error: (message) => write(`error: ${message}\n`),
    },
  };
}

describe("connect", () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kpx-test-"));
    configPath = join(dir, "config", "assoc.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ KPX_CONFIG: configPath, ...extra });

  it("first association stores the id and public idKey with mode 600", async () => {
    const fake = new FakeKeePass({ entries });
    const { logger, lines } = captureLogger();

    const session = await connect({ channel: fake, env: env(), logger });

    expect(session.associated).toBe(true);
    expect(session.version).toBe("2.8.0");
    expect(session.databaseHash).toBe("db-hash-1");
    expect(lines).toContain("info: confirm the connection in KeePassXC\n");

    const stored = JSON.parse(await readFile(configPath, "utf8")) as Record<string, { id: string; idKey: string }>;
    const association = stored["db-hash-1"];
    expect(association?.id).toBe("assoc-1");
    expect(Buffer.from(association?.idKey ?? "", "base64")).toHaveLength(32);
    expect(Object.keys(association ?? {}).sort()).toEqual(["id", "idKey"]);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    session.close();
  });

  it("reconnecting verifies the association without associate", async () => {
    const fake = new FakeKeePass({ entries });
    (await connect({ channel: fake, env: env(), logger: captureLogger().logger })).close();
    const before = fake.calls.length;

    const session = await connect({ channel: fake, env: env(), logger: captureLogger().logger });

    expect(session.associated).toBe(true);
    expect(fake.calls.slice(before)).toEqual(["get-databasehash", "test-associate"]);
    session.close();
  });

  it("an invalid stored association leads to a new associate", async () => {
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(configPath, JSON.stringify({ "db-hash-1": { id: "old", idKey: "AAAA" } }));

    const fake = new FakeKeePass({ entries });
    const session = await connect({ channel: fake, env: env(), logger: captureLogger().logger });

    expect(fake.calls).toContain("associate");
    expect(session.associated).toBe(true);
    session.close();
  });

  it("forceAssociate runs associate even when the association is valid", async () => {
    const fake = new FakeKeePass({ entries });
    (await connect({ channel: fake, env: env(), logger: captureLogger().logger })).close();

    const session = await connect({
      channel: fake,
      env: env(),
      logger: captureLogger().logger,
      forceAssociate: true,
    });

    expect(fake.calls.filter((call) => call === "associate")).toHaveLength(2);
    session.close();
  });

  it("a rejected association gives exit code 5", async () => {
    const fake = new FakeKeePass({ entries, rejectAssociation: true });

    const error = await connect({ channel: fake, env: env(), logger: captureLogger().logger }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KpxError);
    expect((error as KpxError).exitCode).toBe(5);
  });

  it("fetches entries and normalizes KPH attributes", async () => {
    const fake = new FakeKeePass({ entries });
    const session = await connect({ channel: fake, env: env(), logger: captureLogger().logger });

    const [entry] = await session.getLogins("http://loto.dev/players");

    expect(entry).toMatchObject({ name: "Players", login: "admin", uuid: "uuid-1", group: "Work", expired: true });
    expect(entry?.password).toBe("s3cret$\"'");
    expect(entry?.stringFields.get("API_KEY")).toBe("key-1");
    expect(entry?.stringFields.get("DB_URL")).toBe("postgres://x");
    session.close();
  });

  it("error code 15 becomes an empty list of entries", async () => {
    const fake = new FakeKeePass({ entries });
    const session = await connect({ channel: fake, env: env(), logger: captureLogger().logger });

    expect(await session.getLogins("http://unknown.example/")).toEqual([]);
    session.close();
  });

  it("requests TOTP by uuid", async () => {
    const fake = new FakeKeePass({ entries });
    const session = await connect({ channel: fake, env: env(), logger: captureLogger().logger });

    expect(await session.getTotp("uuid-1")).toBe("123456");
    session.close();
  });

  it("waits for unlock, retries the request and ignores unsolicited messages", async () => {
    const options: FakeOptions = { entries, locked: true, unlockDelayMs: 20, noise: true };
    const fake = new FakeKeePass(options);
    const { logger, lines } = captureLogger();

    const session = await connect({ channel: fake, env: env(), logger });
    const [entry] = await session.getLogins("http://loto.dev/players");

    expect(entry?.login).toBe("admin");
    expect(lines).toContain("info: database is locked: unlock it in KeePassXC\n");
    // initial request, unlock trigger, and retry after unlock
    expect(fake.calls.filter((call) => call === "get-databasehash")).toHaveLength(3);
    session.close();
  });

  it("unlock timeout gives exit code 4", async () => {
    const fake = new FakeKeePass({ entries, locked: true, unlockDelayMs: 500 });

    const error = await connect({
      channel: fake,
      env: env({ KPX_UNLOCK_TIMEOUT: "0.05" }),
      logger: captureLogger().logger,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KpxError);
    expect((error as KpxError).exitCode).toBe(4);
  });

  it("with a locked database and allowUnlock=false the session reports status without an error", async () => {
    const fake = new FakeKeePass({ entries, locked: true });

    const session = await connect({
      channel: fake,
      env: env(),
      logger: captureLogger().logger,
      allowUnlock: false,
      allowAssociate: false,
    });

    expect(session.version).toBe("2.8.0");
    expect(session.databaseHash).toBeUndefined();
    expect(session.associated).toBe(false);
    session.close();
  });

  it("an invalid nonce in the reply is an error", async () => {
    const fake = new FakeKeePass({ entries, wrongNonce: true });

    const error = await connect({ channel: fake, env: env(), logger: captureLogger().logger }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KpxError);
    expect((error as Error).message).toContain("nonce");
  });
});
