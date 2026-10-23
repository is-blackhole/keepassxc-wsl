import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KpxError } from "./errors.js";
import type { Association } from "./protocol.js";
import { writeFileAtomic } from "./output.js";

export type Associations = Record<string, Association>;

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.KPX_CONFIG || join(homedir(), ".config", "kpx", "assoc.json");
}

async function readAll(path: string): Promise<Associations> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(text) as Associations;
  } catch {
    throw new KpxError(`association file is corrupted: ${path}`);
  }
}

export async function loadAssociation(path: string, databaseHash: string): Promise<Association | undefined> {
  const all = await readAll(path);
  return all[databaseHash];
}

export async function saveAssociation(path: string, databaseHash: string, association: Association): Promise<void> {
  const all = await readAll(path);
  all[databaseHash] = association;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(all, null, 2)}\n`, 0o600);
}
