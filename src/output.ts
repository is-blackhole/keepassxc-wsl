import { randomBytes } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { KpxError } from "./errors.js";

export type Format = "env" | "shell" | "json";
export type Variables = Array<[string, string]>;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidVarName(name: string): boolean {
  return VAR_NAME.test(name);
}

export function assertVarName(name: string): string {
  if (!isValidVarName(name)) throw new KpxError(`invalid variable name: "${name}"`);
  return name;
}

export function createLogger(quiet: boolean, write: (text: string) => void = (text) => process.stderr.write(text)): Logger {
  return {
    info: (message) => {
      if (!quiet) write(`${message}\n`);
    },
    warn: (message) => {
      if (!quiet) write(`warning: ${message}\n`);
    },
    error: (message) => write(`error: ${message}\n`),
  };
}

/** Serialize for Node.js dotenv syntax, rejecting values that cannot round-trip. */
export function quoteEnvValue(value: string): string {
  const candidates = ['"', "'", "`"]
    .filter((quote) => !value.includes(quote))
    .map((quote) => `${quote}${value}${quote}`);
  candidates.push(value);

  for (const candidate of candidates) {
    const parsed = parseEnv(`KEY=${candidate}\n`);
    if (Object.keys(parsed).length === 1 && parsed.KEY === value) return candidate;
  }
  throw new KpxError("value cannot be represented losslessly in dotenv format; use --format json or --format shell");
}

export function escapeShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatVariables(variables: Variables, format: Format): string {
  switch (format) {
    case "env":
      return variables.map(([key, value]) => `${key}=${quoteEnvValue(value)}\n`).join("");
    case "shell":
      return variables.map(([key, value]) => `export ${key}=${escapeShellValue(value)}\n`).join("");
    case "json":
      return `${JSON.stringify(Object.fromEntries(variables), null, 2)}\n`;
  }
}

export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content, { mode });
    await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
