import { KpxError } from "./errors.js";
import { DEFAULT_FIELD, type Entry, type EntryFilter } from "./select.js";

export interface Reference {
  raw: string;
  url: string;
  field: string;
  filter: EntryFilter;
}

export type Token = { kind: "text"; text: string } | { kind: "ref"; ref: Reference };

export interface RenderDeps {
  select(url: string, filter: EntryFilter): Promise<Entry>;
  readField(entry: Entry, field: string): Promise<string>;
}

export interface RenderFailure {
  raw: string;
  error: unknown;
}

export interface RenderResult {
  text: string;
  errors: RenderFailure[];
}

const FILTER_KEYS = ["name", "login", "group", "uuid"] as const;
const OPEN = "{{kp:";
const CLOSE = "}}";
const ESCAPED_OPEN = "\\{{";

export function parseTemplate(source: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") tokens.push({ kind: "text", text });
    text = "";
  };

  let i = 0;
  while (i < source.length) {
    if (source.startsWith(ESCAPED_OPEN, i)) {
      text += "{{";
      i += ESCAPED_OPEN.length;
      continue;
    }
    if (source.startsWith(OPEN, i)) {
      const end = source.indexOf(CLOSE, i + OPEN.length);
      if (end !== -1) {
        flush();
        tokens.push({ kind: "ref", ref: parseReference(source.slice(i + OPEN.length, end)) });
        i = end + CLOSE.length;
        continue;
      }
    }
    text += source.charAt(i);
    i++;
  }
  flush();
  return tokens;
}

/** Reference body: `<url>#<field>?name=X&login=Y`. A `#` inside the URL is not supported. */
export function parseReference(body: string): Reference {
  const raw = `${OPEN}${body}${CLOSE}`;
  const match = /^([^#]*)(?:#([^?]*))?(?:\?(.*))?$/s.exec(body);
  const url = match?.[1] ?? "";
  if (url === "") throw new KpxError(`empty URL in template: ${raw}`);

  const field = match?.[2] || DEFAULT_FIELD;
  const filter: EntryFilter = {};
  const params = new URLSearchParams(match?.[3] ?? "");
  for (const [key, value] of params) {
    if (!(FILTER_KEYS as readonly string[]).includes(key)) {
      throw new KpxError(`unknown filter "${key}" in template: ${raw}`);
    }
    filter[key as (typeof FILTER_KEYS)[number]] = value;
  }
  return { raw, url, field, filter };
}

function cacheKey(ref: Reference): string {
  const { name = null, login = null, group = null, uuid = null } = ref.filter;
  return JSON.stringify([ref.url, name, login, group, uuid]);
}

/**
 * Entries are loaded once per url+filters pair, even if the template uses
 * several fields of the same entry. Errors are collected instead of thrown at once.
 */
export async function renderTemplate(tokens: Token[], deps: RenderDeps): Promise<RenderResult> {
  const cache = new Map<string, Promise<Entry>>();
  const errors: RenderFailure[] = [];
  let text = "";

  for (const token of tokens) {
    if (token.kind === "text") {
      text += token.text;
      continue;
    }
    const { ref } = token;
    try {
      const key = cacheKey(ref);
      let entry = cache.get(key);
      if (!entry) {
        entry = deps.select(ref.url, ref.filter);
        cache.set(key, entry);
      }
      text += await deps.readField(await entry, ref.field);
    } catch (error) {
      errors.push({ raw: ref.raw, error });
    }
  }
  return { text, errors };
}
