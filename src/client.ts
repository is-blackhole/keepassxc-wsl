import { EXIT, KpxError } from "./errors.js";
import type { Logger } from "./output.js";
import {
  type Association,
  KeePassProtocol,
  KEEPASS_ERROR,
  type Timeouts,
  isAssociationRejected,
  isKeePassError,
} from "./protocol.js";
import { normalizeEntry, type Entry } from "./select.js";
import { loadAssociation, resolveConfigPath, saveAssociation } from "./store.js";
import { type Channel, Transport, resolveProxyPath } from "./transport.js";

export interface ConnectOptions {
  env?: NodeJS.ProcessEnv;
  logger: Logger;
  /** Channel for tests; by default keepassxc-proxy is started. */
  channel?: Channel;
  /** Allow the unlock trigger and waiting for unlock (default true). */
  allowUnlock?: boolean;
  /** Allow creating a new association (default true). */
  allowAssociate?: boolean;
  /** Ignore the stored association and run associate again. */
  forceAssociate?: boolean;
}

function readSeconds(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new KpxError(`invalid value for ${name}: ${value}`);
  }
  return seconds;
}

export function resolveTimeouts(env: NodeJS.ProcessEnv = process.env): Timeouts {
  return {
    requestMs: readSeconds(env.KPX_TIMEOUT, 30, "KPX_TIMEOUT") * 1000,
    unlockMs: readSeconds(env.KPX_UNLOCK_TIMEOUT, 120, "KPX_UNLOCK_TIMEOUT") * 1000,
  };
}

export class KeePassSession {
  constructor(
    private readonly channel: Channel,
    private readonly protocol: KeePassProtocol,
    private readonly allowUnlock: boolean,
    readonly version: string | undefined,
    readonly databaseHash: string | undefined,
    private readonly association: Association | undefined,
  ) {}

  get associated(): boolean {
    return this.association !== undefined;
  }

  async getLogins(url: string): Promise<Entry[]> {
    if (this.databaseHash === undefined) throw new KpxError("KeePassXC database is locked", EXIT.LOCKED);
    if (!this.association) {
      throw new KpxError("no association with the database, run `kpx associate`", EXIT.ASSOC_REJECTED);
    }
    const raw = await this.protocol.getLogins(url, this.association, this.allowUnlock);
    return raw.map(normalizeEntry);
  }

  getTotp(uuid: string): Promise<string> {
    return this.protocol.getTotp(uuid, this.allowUnlock);
  }

  close(): void {
    this.channel.close();
  }
}

/**
 * Order: key exchange → database hash → check the stored association
 * → associate if needed (the user confirms in KeePassXC).
 */
export async function connect(options: ConnectOptions): Promise<KeePassSession> {
  const env = options.env ?? process.env;
  const { logger, allowUnlock = true, allowAssociate = true, forceAssociate = false } = options;
  const channel = options.channel ?? new Transport(resolveProxyPath(env));

  try {
    const protocol = new KeePassProtocol(channel, {
      timeouts: resolveTimeouts(env),
      notify: (message) => logger.info(message),
    });
    const version = await protocol.exchangeKeys();

    const databaseHash = await readDatabaseHash(protocol, allowUnlock);
    const association =
      databaseHash === undefined
        ? undefined
        : await ensureAssociation(protocol, databaseHash, {
            configPath: resolveConfigPath(env),
            logger,
            allowAssociate,
            forceAssociate,
          });

    return new KeePassSession(channel, protocol, allowUnlock, version, databaseHash, association);
  } catch (error) {
    channel.close();
    throw error;
  }
}

async function readDatabaseHash(protocol: KeePassProtocol, allowUnlock: boolean): Promise<string | undefined> {
  try {
    return await protocol.getDatabaseHash(allowUnlock);
  } catch (error) {
    if (!allowUnlock && isKeePassError(error, KEEPASS_ERROR.DATABASE_NOT_OPENED)) return undefined;
    throw error;
  }
}

interface AssociationOptions {
  configPath: string;
  logger: Logger;
  allowAssociate: boolean;
  forceAssociate: boolean;
}

async function ensureAssociation(
  protocol: KeePassProtocol,
  databaseHash: string,
  options: AssociationOptions,
): Promise<Association | undefined> {
  if (!options.forceAssociate) {
    const stored = await loadAssociation(options.configPath, databaseHash);
    if (stored && (await isAssociationValid(protocol, stored))) return stored;
  }
  if (!options.allowAssociate) return undefined;

  options.logger.info("confirm the connection in KeePassXC");
  let association: Association;
  try {
    association = await protocol.associate();
  } catch (error) {
    if (isAssociationRejected(error)) {
      throw new KpxError("association was rejected in KeePassXC", EXIT.ASSOC_REJECTED);
    }
    throw error;
  }
  await saveAssociation(options.configPath, databaseHash, association);
  return association;
}

async function isAssociationValid(protocol: KeePassProtocol, association: Association): Promise<boolean> {
  try {
    await protocol.testAssociate(association);
    return true;
  } catch (error) {
    if (isKeePassError(error)) return false;
    throw error;
  }
}
