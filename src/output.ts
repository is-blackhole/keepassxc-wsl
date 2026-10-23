import { randomBytes } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
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

export function escapeEnvValue(value: string): string {
  return value
    .replace(/[\\"$]/g, (char) => `\\${char}`)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

export function escapeShellValue(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatVariables(variables: Variables, format: Format): string {
  switch (format) {
    case "env":
      return variables.map(([key, value]) => `${key}="${escapeEnvValue(value)}"\n`).join("");
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
