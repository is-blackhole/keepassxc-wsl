import { EXIT, KpxError } from "./errors.js";
import type { RawEntry, RawEntryMeta } from "./protocol.js";

export interface Entry {
  name: string;
  login: string;
  password: string;
  uuid: string;
  group: string;
  expired: boolean;
  /** `KPH: ` attributes with the prefix stripped, e.g. `API_KEY` for the key `KPH: API_KEY`. */
  stringFields: Map<string, string>;
  totp?: string;
}

export interface EntryFilter {
  name?: string;
  login?: string;
  group?: string;
  uuid?: string;
}

const KPH_PREFIX = "KPH: ";
export const DEFAULT_FIELD = "password";

/** Entry metadata returned by `get-database-entries`: URL, title and UUID only. */
export interface EntryMeta {
  name: string;
  uuid: string;
  url: string;
}

export function normalizeEntryMeta(raw: RawEntryMeta): EntryMeta {
  return {
    name: raw.title ?? "",
    uuid: raw.uuid ?? "",
    url: raw.url ?? "",
  };
}

/** Case-insensitive substring match against the entry URL or title. */
export function matchFragment(fragment: string, meta: Pick<EntryMeta, "url" | "name">): boolean {
  if (fragment === "") return true;
  const needle = fragment.toLowerCase();
  return meta.url.toLowerCase().includes(needle) || meta.name.toLowerCase().includes(needle);
}

export function normalizeEntry(raw: RawEntry): Entry {
  const stringFields = new Map<string, string>();
  for (const field of raw.stringFields ?? []) {
    for (const [key, value] of Object.entries(field)) {
      if (key.startsWith(KPH_PREFIX)) stringFields.set(key.slice(KPH_PREFIX.length), value);
    }
  }
  return {
    name: raw.name ?? "",
    login: raw.login ?? "",
    password: raw.password ?? "",
    uuid: raw.uuid ?? "",
    group: raw.group ?? "",
    expired: raw.expired === true || raw.expired === "true",
    stringFields,
    totp: raw.totp ? raw.totp : undefined,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchGlob(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "s").test(value);
}

export function filterEntries(entries: Entry[], filter: EntryFilter): Entry[] {
  return entries.filter(
    (entry) =>
      (filter.name === undefined || matchGlob(filter.name, entry.name)) &&
      (filter.login === undefined || entry.login === filter.login) &&
      (filter.group === undefined || entry.group === filter.group) &&
      (filter.uuid === undefined || entry.uuid === filter.uuid),
  );
}

function describe(entry: Entry): string {
  return `${entry.name} / ${entry.login} / ${entry.group} / ${entry.uuid}`;
}

export function selectEntry(entries: Entry[], filter: EntryFilter): Entry {
  const matches = filterEntries(entries, filter);
  const [first, ...rest] = matches;
  if (!first) throw new KpxError("entry not found", EXIT.NOT_FOUND);
  if (rest.length > 0) {
    const list = matches.map((entry) => `  ${describe(entry)}`).join("\n");
    throw new KpxError(
      `multiple entries found, narrow the filters (name / login / group / uuid):\n${list}`,
      EXIT.AMBIGUOUS,
    );
  }
  return first;
}

/**
 * Built-in fields take precedence over attributes with the same name.
 * `totp` is fetched with a separate request if KeePassXC did not return it with the entry.
 */
export async function readField(
  entry: Entry,
  field: string,
  fetchTotp: (uuid: string) => Promise<string>,
): Promise<string> {
  switch (field) {
    case "password":
      return entry.password;
    case "login":
      return entry.login;
    case "name":
      return entry.name;
    case "uuid":
      return entry.uuid;
    case "totp": {
      const totp = entry.totp ?? (await fetchTotp(entry.uuid));
      if (!totp) throw new KpxError("entry has no TOTP");
      return totp;
    }
  }
  const value = entry.stringFields.get(field);
  if (value === undefined) throw new KpxError(`entry has no attribute "KPH: ${field}"`);
  return value;
}
