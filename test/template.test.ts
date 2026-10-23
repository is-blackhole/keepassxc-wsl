import { describe, expect, it } from "vitest";
import { KpxError } from "../src/errors.js";
import { normalizeEntry, type Entry, type EntryFilter } from "../src/select.js";
import { parseReference, parseTemplate, renderTemplate } from "../src/template.js";

const entry: Entry = normalizeEntry({
  name: "Players",
  login: "admin",
  password: "pw",
  uuid: "u1",
  group: "Work",
  stringFields: [{ "KPH: API_KEY": "key-1" }, { "KPH: DB": "postgres://x" }],
});

function deps(calls: Array<{ url: string; filter: EntryFilter }> = []) {
  return {
    select: async (url: string, filter: EntryFilter): Promise<Entry> => {
      calls.push({ url, filter });
      if (url === "http://missing") throw new KpxError("entry not found", 2);
      return entry;
    },
    readField: async (selected: Entry, field: string): Promise<string> => {
      const value = selected.stringFields.get(field) ?? (field === "password" ? selected.password : undefined);
      if (value === undefined) throw new KpxError(`entry has no attribute "KPH: ${field}"`);
      return value;
    },
  };
}

describe("parseTemplate", () => {
  it("copies text unchanged and extracts references", () => {
    const tokens = parseTemplate("A=1\nKEY={{kp:http://loto.dev/players#API_KEY}}\n");
    expect(tokens).toEqual([
      { kind: "text", text: "A=1\nKEY=" },
      {
        kind: "ref",
        ref: {
          raw: "{{kp:http://loto.dev/players#API_KEY}}",
          url: "http://loto.dev/players",
          field: "API_KEY",
          filter: {},
        },
      },
      { kind: "text", text: "\n" },
    ]);
  });

  it("\\{{ escapes the opening braces", () => {
    const tokens = parseTemplate("\\{{kp:http://x#password}}");
    expect(tokens).toEqual([{ kind: "text", text: "{{kp:http://x#password}}" }]);
  });

  it("an unclosed reference stays as text", () => {
    expect(parseTemplate("{{kp:http://x#pw")).toEqual([{ kind: "text", text: "{{kp:http://x#pw" }]);
  });
});

describe("parseReference", () => {
  it("parses filters after the field", () => {
    const ref = parseReference("http://loto.dev/players#API_KEY?name=Prod*&login=admin");
    expect(ref.url).toBe("http://loto.dev/players");
    expect(ref.field).toBe("API_KEY");
    expect(ref.filter).toEqual({ name: "Prod*", login: "admin" });
  });

  it("uses password when no field is given", () => {
    expect(parseReference("http://x/y").field).toBe("password");
  });

  it("rejects an unknown filter", () => {
    expect(() => parseReference("http://x#pw?title=A")).toThrow(KpxError);
  });

  it("rejects an empty URL", () => {
    expect(() => parseReference("#password")).toThrow(KpxError);
  });
});

describe("renderTemplate", () => {
  it("substitutes values and copies the rest of the text", async () => {
    const tokens = parseTemplate("K={{kp:http://loto.dev/players#API_KEY}} P={{kp:http://loto.dev/players}}");
    const result = await renderTemplate(tokens, deps());
    expect(result).toEqual({ text: "K=key-1 P=pw", errors: [] });
  });

  it("caches the selection per url+filters pair", async () => {
    const calls: Array<{ url: string; filter: EntryFilter }> = [];
    const tokens = parseTemplate(
      "{{kp:http://a#API_KEY}}{{kp:http://a#DB}}{{kp:http://a#API_KEY?name=X}}{{kp:http://a#DB?name=X}}",
    );

    await renderTemplate(tokens, deps(calls));

    expect(calls).toEqual([
      { url: "http://a", filter: {} },
      { url: "http://a", filter: { name: "X" } },
    ]);
  });

  it("collects all errors without throwing", async () => {
    const tokens = parseTemplate("{{kp:http://missing#pw}} ok {{kp:http://a#NOPE}}");
    const result = await renderTemplate(tokens, deps());

    expect(result.errors.map((failure) => failure.raw)).toEqual(["{{kp:http://missing#pw}}", "{{kp:http://a#NOPE}}"]);
    expect(result.errors[0]?.error).toBeInstanceOf(KpxError);
  });
});
