import { describe, expect, it } from "vitest";
import { KpxError } from "../src/errors.js";
import { matchGlob, normalizeEntry, readField, selectEntry, type Entry } from "../src/select.js";

const raw = [
  {
    name: "Players prod",
    login: "admin",
    password: "p1",
    uuid: "u1",
    group: "Work/loto",
    expired: "false",
    stringFields: [{ "KPH: API_KEY": "k1" }, { "KPH: Mode": "prod" }, { Plain: "ignored" }],
  },
  {
    name: "Players dev",
    login: "admin",
    password: "p2",
    uuid: "u2",
    group: "Work/loto",
    expired: "true",
    stringFields: [{ "KPH: API_KEY": "k2" }],
  },
];

function entries(): Entry[] {
  return raw.map(normalizeEntry);
}

describe("normalizeEntry", () => {
  it("strips the KPH: prefix and ignores other string fields", () => {
    const [entry] = entries();
    expect(entry?.stringFields.get("API_KEY")).toBe("k1");
    expect(entry?.stringFields.get("Mode")).toBe("prod");
    expect(entry?.stringFields.has("Plain")).toBe(false);
  });

  it("reads expired from a string", () => {
    const [, expired] = entries();
    expect(expired?.expired).toBe(true);
  });
});

describe("selectEntry", () => {
  it("selects the single entry matching a glob name", () => {
    expect(selectEntry(entries(), { name: "Players prod" }).uuid).toBe("u1");
    expect((capture(() => selectEntry(entries(), { name: "Players *" })) as KpxError).exitCode).toBe(3);
  });

  it("matches login, group and uuid exactly", () => {
    expect(selectEntry(entries(), { uuid: "u2" }).name).toBe("Players dev");
    expect(selectEntry(entries(), { group: "Work/loto", name: "*dev" }).uuid).toBe("u2");
  });

  it("zero entries give exit code 2", () => {
    const error = capture(() => selectEntry(entries(), { name: "nope" }));
    expect(error).toBeInstanceOf(KpxError);
    expect((error as KpxError).exitCode).toBe(2);
  });

  it("multiple entries give exit code 3 and a list in the message", () => {
    const error = capture(() => selectEntry(entries(), { login: "admin" }));
    expect((error as KpxError).exitCode).toBe(3);
    expect((error as Error).message).toContain("Players prod / admin / Work/loto / u1");
    expect((error as Error).message).toContain("Players dev / admin / Work/loto / u2");
  });
});

describe("matchGlob", () => {
  it("without an asterisk requires a full match", () => {
    expect(matchGlob("abc", "abc")).toBe(true);
    expect(matchGlob("abc", "abcd")).toBe(false);
  });

  it("escapes regular expression special characters", () => {
    expect(matchGlob("a.b*", "a.bXYZ")).toBe(true);
    expect(matchGlob("a.b*", "aXbXYZ")).toBe(false);
    expect(matchGlob("(x)*", "(x)and more")).toBe(true);
  });
});

describe("readField", () => {
  const noTotp = (): Promise<string> => Promise.reject(new Error("unexpected"));
  const [entry] = entries();

  it("built-in fields by default and by name", async () => {
    expect(await readField(entry!, "password", noTotp)).toBe("p1");
    expect(await readField(entry!, "login", noTotp)).toBe("admin");
    expect(await readField(entry!, "name", noTotp)).toBe("Players prod");
    expect(await readField(entry!, "uuid", noTotp)).toBe("u1");
  });

  it("looks up KPH attributes case-sensitively", async () => {
    expect(await readField(entry!, "API_KEY", noTotp)).toBe("k1");
    await expect(readField(entry!, "api_key", noTotp)).rejects.toThrow(KpxError);
  });

  it("totp is requested from KeePassXC when the entry does not include it", async () => {
    expect(await readField(entry!, "totp", async (uuid) => `totp-for-${uuid}`)).toBe("totp-for-u1");
  });
});

function capture(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected an exception");
}
