#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { type KeePassSession, connect } from "./client.js";
import { EXIT, KpxError } from "./errors.js";
import {
  type Format,
  type Logger,
  type Variables,
  assertVarName,
  createLogger,
  formatVariables,
  isValidVarName,
} from "./output.js";
import { isAssociationRejected, isKeePassError, KEEPASS_ERROR } from "./protocol.js";
import { DEFAULT_FIELD, type Entry, type EntryFilter, matchFragment, readField, selectEntry } from "./select.js";
import { resolveProxyPath } from "./transport.js";

const OPTIONS = {
  quiet: { type: "boolean", short: "q" },
  help: { type: "boolean", short: "h" },
  field: { type: "string", short: "f" },
  name: { type: "string" },
  login: { type: "string" },
  group: { type: "string" },
  uuid: { type: "string" },
  format: { type: "string" },
  prefix: { type: "string" },
  only: { type: "string" },
  "with-login": { type: "string" },
  "with-password": { type: "string" },
} as const;

interface Options {
  quiet?: boolean;
  help?: boolean;
  field?: string;
  name?: string;
  login?: string;
  group?: string;
  uuid?: string;
  format?: string;
  prefix?: string;
  only?: string;
  "with-login"?: string;
  "with-password"?: string;
}

interface Context {
  options: Options;
  args: string[];
  tail: string[];
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

const USAGE = `Usage:
  kpx get <url> [-f FIELD] [--name N] [--login L] [--group G] [--uuid U]
  kpx env <url> [filters] [--format env|json] [--prefix P] [--only A,B]
                [--with-login VAR] [--with-password VAR]
  kpx list [fragment]
  kpx completion
  kpx run <url> [filters] [--only A,B] -- <command> [args…]
  kpx associate
  kpx status

Common flags: -q, --quiet (do not print diagnostics to stderr), -h, --help
`;

function usage(message: string): KpxError {
  return new KpxError(`${message}\nHint: kpx --help`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitCodeFor(error: unknown): number {
  if (error instanceof KpxError) return error.exitCode;
  if (isKeePassError(error, KEEPASS_ERROR.DATABASE_NOT_OPENED)) return EXIT.LOCKED;
  if (isAssociationRejected(error)) return EXIT.ASSOC_REJECTED;
  return EXIT.FAILURE;
}

function requireArg(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value) throw usage(`missing argument: ${name}`);
  return value;
}

function filterFrom(options: Options): EntryFilter {
  return { name: options.name, login: options.login, group: options.group, uuid: options.uuid };
}

function parseFormat(value: string): Format {
  if (value === "env" || value === "json") return value;
  throw usage(`unknown format: ${value}`);
}

async function withSession<T>(
  context: Context,
  connectOptions: { allowUnlock?: boolean; allowAssociate?: boolean; forceAssociate?: boolean },
  action: (session: KeePassSession) => Promise<T>,
): Promise<T> {
  const session = await connect({ env: context.env, logger: context.logger, ...connectOptions });
  try {
    return await action(session);
  } finally {
    session.close();
  }
}

async function selectFor(
  session: KeePassSession,
  url: string,
  filter: EntryFilter,
  logger: Logger,
): Promise<Entry> {
  const entry = selectEntry(await session.getLogins(url), filter);
  if (entry.expired) logger.warn(`entry "${entry.name}" is marked as expired`);
  return entry;
}

interface VariableOptions {
  prefix: string;
  only?: Set<string>;
  withLogin?: string;
  withPassword?: string;
}

function collectVariables(entry: Entry, options: VariableOptions, logger: Logger): Variables {
  const variables: Variables = [];
  for (const [name, value] of entry.stringFields) {
    if (options.only && !options.only.has(name)) continue;
    const key = `${options.prefix}${name}`;
    if (isValidVarName(key)) {
      variables.push([key, value]);
    } else {
      logger.warn(`attribute "${name}" skipped: invalid variable name`);
    }
  }
  if (options.withLogin !== undefined) variables.push([assertVarName(options.withLogin), entry.login]);
  if (options.withPassword !== undefined) variables.push([assertVarName(options.withPassword), entry.password]);
  return variables;
}

function parseOnly(value: string | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  return new Set(
    value
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

async function cmdGet(context: Context): Promise<number> {
  const url = requireArg(context.args, 0, "url");
  const field = context.options.field ?? DEFAULT_FIELD;
  const value = await withSession(context, {}, async (session) => {
    const entry = await selectFor(session, url, filterFrom(context.options), context.logger);
    return readField(entry, field, (uuid) => session.getTotp(uuid));
  });
  process.stdout.write(process.stdout.isTTY ? `${value}\n` : value);
  return EXIT.OK;
}

async function cmdEnv(context: Context): Promise<number> {
  const url = requireArg(context.args, 0, "url");
  const { options, logger } = context;
  const format = parseFormat(options.format ?? "env");
  const variables = await withSession(context, {}, async (session) => {
    const entry = await selectFor(session, url, filterFrom(options), logger);
    return collectVariables(
      entry,
      {
        prefix: options.prefix ?? "",
        only: parseOnly(options.only),
        withLogin: options["with-login"],
        withPassword: options["with-password"],
      },
      logger,
    );
  });
  process.stdout.write(formatVariables(variables, format));
  return EXIT.OK;
}

async function cmdList(context: Context): Promise<number> {
  const fragment = context.args[0] ?? "";
  const metas = await withSession(context, {}, async (session) => session.listEntries());
  const lines = metas
    .filter((meta) => matchFragment(fragment, meta))
    .map((meta) => `${meta.url}\t${meta.name}\t${meta.uuid}`);
  process.stdout.write(`${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`);
  return EXIT.OK;
}

/** The Bash completion script lives next to the build output, see `completions/`. */
const COMPLETION_PATH = fileURLToPath(new URL("../completions/kpx.bash", import.meta.url));

async function cmdCompletion(): Promise<number> {
  process.stdout.write(await readFile(COMPLETION_PATH, "utf8"));
  return EXIT.OK;
}

async function cmdRun(context: Context): Promise<number> {
  const url = requireArg(context.args, 0, "url");
  const [file, ...argv] = context.tail;
  if (file === undefined) throw usage("specify a command after --");
  const { logger } = context;

  const variables = await withSession(context, {}, async (session) => {
    const entry = await selectFor(session, url, filterFrom(context.options), logger);
    return collectVariables(entry, { prefix: "", only: parseOnly(context.options.only) }, logger);
  });

  return runChild(file, argv, Object.fromEntries(variables), context.env, logger);
}

function runChild(
  file: string,
  argv: string[],
  variables: Record<string, string>,
  env: NodeJS.ProcessEnv,
  logger: Logger,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, argv, { stdio: "inherit", env: { ...env, ...variables } });
    child.on("error", (error) => {
      logger.error(`failed to start ${file}: ${error.message}`);
      resolve(EXIT.FAILURE);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : EXIT.FAILURE)));
  });
}

async function cmdAssociate(context: Context): Promise<number> {
  await withSession(context, { forceAssociate: true }, async (session) => {
    if (!session.associated) throw new KpxError("association was not created", EXIT.ASSOC_REJECTED);
  });
  context.logger.info("association saved");
  return EXIT.OK;
}

async function cmdStatus(context: Context): Promise<number> {
  const proxy = resolveProxyPath(context.env);
  const proxyFound = existsSync(proxy);
  const lines = [`proxy: ${proxy} (${proxyFound ? "found" : "not found"})`];
  if (!proxyFound) {
    process.stdout.write(`${lines.join("\n")}\n`);
    return EXIT.FAILURE;
  }

  const session = await connect({
    env: context.env,
    logger: context.logger,
    allowUnlock: false,
    allowAssociate: false,
  });
  try {
    lines.push(
      `KeePassXC: ${session.version ?? "version unknown"}`,
      `database: ${session.databaseHash === undefined ? "locked" : "open"}`,
      `association: ${session.associated ? "valid" : "none"}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    return session.associated ? EXIT.OK : EXIT.FAILURE;
  } finally {
    session.close();
  }
}

const COMMANDS: Record<string, (context: Context) => Promise<number>> = {
  get: cmdGet,
  env: cmdEnv,
  run: cmdRun,
  associate: cmdAssociate,
  list: cmdList,
  completion: cmdCompletion,
  status: cmdStatus,
};

const COMMON_OPTIONS = ["quiet", "help"] as const;

/** Options each command accepts; anything else is a usage error rather than a silent no-op. */
const COMMAND_OPTIONS: Record<string, ReadonlyArray<keyof Options>> = {
  get: ["field", "name", "login", "group", "uuid"],
  env: ["name", "login", "group", "uuid", "format", "prefix", "only", "with-login", "with-password"],
  run: ["name", "login", "group", "uuid", "only"],
  list: [],
  completion: [],
  associate: [],
  status: [],
};

function validateOptions(command: string, values: Record<string, unknown>): void {
  const allowed = new Set<string>([...COMMON_OPTIONS, ...(COMMAND_OPTIONS[command] ?? [])]);
  const unsupported = Object.keys(values).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    const list = unsupported.map((key) => `--${key}`).join(", ");
    throw usage(`${command}: unsupported option ${list}`);
  }
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let logger = createLogger(false);
  try {
    const separator = argv.indexOf("--");
    const head = separator === -1 ? argv : argv.slice(0, separator);
    const tail = separator === -1 ? [] : argv.slice(separator + 1);

    const { values, positionals } = parseArgs({
      args: head,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const options = values as Options;
    logger = createLogger(options.quiet === true);

    const [command, ...args] = positionals;
    if (options.help || command === undefined) {
      process.stdout.write(USAGE);
      return command === undefined && !options.help ? EXIT.FAILURE : EXIT.OK;
    }

    const handler = COMMANDS[command];
    if (!handler) throw usage(`unknown command: ${command}`);
    validateOptions(command, values);
    return await handler({ options, args, tail, env, logger });
  } catch (error) {
    logger.error(errorMessage(error));
    return exitCodeFor(error);
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
