import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { EXIT, KpxError } from "./errors.js";
import { type Channel, type Message, waitForMessage } from "./transport.js";

export const KEEPASS_ERROR = {
  DATABASE_NOT_OPENED: 1,
  ACTION_DENIED: 6,
  ENCRYPTION_FAILED: 7,
  ASSOCIATION_FAILED: 8,
  NO_LOGINS_FOUND: 15,
} as const;

export class KeePassError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "KeePassError";
  }
}

export interface Association {
  id: string;
  idKey: string;
}

export interface RawEntry {
  name?: string;
  login?: string;
  password?: string;
  uuid?: string;
  group?: string;
  expired?: boolean | string;
  stringFields?: Array<Record<string, string>>;
  totp?: string;
}

export interface RawEntryMeta {
  title?: string;
  uuid?: string;
  url?: string;
}

export interface Timeouts {
  requestMs: number;
  unlockMs: number;
}

export interface ProtocolOptions {
  timeouts: Timeouts;
  notify?: (message: string) => void;
}

interface CallOptions {
  allowUnlock?: boolean;
  timeoutMs?: number;
}

export function incrementNonce(nonce: Uint8Array): Uint8Array {
  const next = new Uint8Array(nonce);
  let carry = 1;
  for (let i = 0; i < next.length && carry !== 0; i++) {
    const sum = (next[i] ?? 0) + carry;
    next[i] = sum & 0xff;
    carry = sum >> 8;
  }
  return next;
}

export function isKeePassError(error: unknown, code?: number): error is KeePassError {
  return error instanceof KeePassError && (code === undefined || error.code === code);
}

export function isAssociationRejected(error: unknown): boolean {
  return (
    isKeePassError(error) &&
    (error.code === KEEPASS_ERROR.ACTION_DENIED ||
      error.code === KEEPASS_ERROR.ENCRYPTION_FAILED ||
      error.code === KEEPASS_ERROR.ASSOCIATION_FAILED)
  );
}

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

function throwIfError(message: Message): void {
  if (message.error === undefined) return;
  const text = typeof message.error === "string" ? message.error : "unknown KeePassXC error";
  throw new KeePassError(text, Number(message.errorCode ?? 0));
}

function requireString(message: Message, key: string): string {
  const value = message[key];
  if (typeof value !== "string" || value === "") {
    throw new KpxError(`KeePassXC did not return field "${key}"`);
  }
  return value;
}

/**
 * Client for the browser integration protocol. Requests run sequentially:
 * replies are matched to requests by `action`, unsolicited events are ignored.
 */
export class KeePassProtocol {
  readonly clientID = randomBytes(24).toString("base64");
  private readonly keys = nacl.box.keyPair();
  private serverPublicKey: Uint8Array | undefined;

  constructor(
    private readonly channel: Channel,
    private readonly options: ProtocolOptions,
  ) {}

  async exchangeKeys(): Promise<string | undefined> {
    const reply = await this.roundTrip(
      "change-public-keys",
      {
        action: "change-public-keys",
        publicKey: toBase64(this.keys.publicKey),
        nonce: toBase64(randomBytes(24)),
        clientID: this.clientID,
      },
      this.options.timeouts.requestMs,
    );
    throwIfError(reply);
    this.serverPublicKey = fromBase64(requireString(reply, "publicKey"));
    return typeof reply.version === "string" ? reply.version : undefined;
  }

  async getDatabaseHash(allowUnlock: boolean): Promise<string> {
    const reply = await this.call("get-databasehash", {}, { allowUnlock });
    return requireString(reply, "hash");
  }

  async associate(): Promise<Association> {
    const idKeys = nacl.box.keyPair();
    const idKey = toBase64(idKeys.publicKey);
    const reply = await this.call(
      "associate",
      { key: toBase64(this.keys.publicKey), idKey },
      { timeoutMs: this.options.timeouts.unlockMs },
    );
    return { id: requireString(reply, "id"), idKey };
  }

  async testAssociate(association: Association): Promise<void> {
    await this.call("test-associate", { id: association.id, key: association.idKey });
  }

  async getLogins(url: string, association: Association, allowUnlock: boolean): Promise<RawEntry[]> {
    try {
      const reply = await this.call(
        "get-logins",
        { url, keys: [{ id: association.id, key: association.idKey }] },
        { allowUnlock, timeoutMs: this.options.timeouts.unlockMs },
      );
      return Array.isArray(reply.entries) ? (reply.entries as RawEntry[]) : [];
    } catch (error) {
      if (isKeePassError(error, KEEPASS_ERROR.NO_LOGINS_FOUND)) return [];
      throw error;
    }
  }

  async getDatabaseEntries(association: Association, allowUnlock: boolean): Promise<RawEntryMeta[]> {
    const reply = await this.call(
      "get-database-entries",
      { keys: [{ id: association.id, key: association.idKey }] },
      { allowUnlock, timeoutMs: this.options.timeouts.unlockMs },
    );
    return Array.isArray(reply.entries) ? (reply.entries as RawEntryMeta[]) : [];
  }

  async getTotp(uuid: string, allowUnlock: boolean): Promise<string> {
    const reply = await this.call("get-totp", { uuid }, { allowUnlock });
    return requireString(reply, "totp");
  }

  private async call(action: string, inner: Record<string, unknown>, options: CallOptions = {}): Promise<Message> {
    const timeoutMs = options.timeoutMs ?? this.options.timeouts.requestMs;
    try {
      return await this.encrypted(action, inner, timeoutMs, false);
    } catch (error) {
      if (!options.allowUnlock || !isKeePassError(error, KEEPASS_ERROR.DATABASE_NOT_OPENED)) throw error;
    }
    return this.unlockAndRetry(action, inner, timeoutMs);
  }

  /**
   * The database-unlocked listener is created before the triggerUnlock request,
   * so the event is not missed if the unlock happens before the reply.
   */
  private async unlockAndRetry(action: string, inner: Record<string, unknown>, timeoutMs: number): Promise<Message> {
    const unlockMs = this.options.timeouts.unlockMs;
    const unlocked = waitForMessage(this.channel, unlockMs, (message) => message.action === "database-unlocked");
    unlocked.catch(() => undefined);
    this.options.notify?.("database is locked: unlock it in KeePassXC");

    try {
      return await this.encrypted(action, inner, unlockMs, true);
    } catch (error) {
      if (!isKeePassError(error, KEEPASS_ERROR.DATABASE_NOT_OPENED)) throw error;
    }

    try {
      await unlocked;
    } catch {
      throw new KpxError(`database was not unlocked within ${Math.round(unlockMs / 1000)} s`, EXIT.LOCKED);
    }
    return this.encrypted(action, inner, timeoutMs, false);
  }

  private async encrypted(
    action: string,
    inner: Record<string, unknown>,
    timeoutMs: number,
    triggerUnlock: boolean,
  ): Promise<Message> {
    const serverKey = this.requireServerKey();
    const nonce = randomBytes(24);
    const plain = Buffer.from(JSON.stringify({ action, ...inner }), "utf8");
    const frame: Message = {
      action,
      message: toBase64(nacl.box(plain, nonce, serverKey, this.keys.secretKey)),
      nonce: toBase64(nonce),
      clientID: this.clientID,
    };
    if (triggerUnlock) frame.triggerUnlock = "true";

    const reply = await this.roundTrip(action, frame, timeoutMs);
    throwIfError(reply);
    return this.open(reply, nonce, serverKey);
  }

  private open(reply: Message, requestNonce: Uint8Array, serverKey: Uint8Array): Message {
    const expected = incrementNonce(requestNonce);
    if (typeof reply.nonce !== "string" || !Buffer.from(reply.nonce, "base64").equals(expected)) {
      throw new KpxError("invalid nonce in KeePassXC reply");
    }
    const plain = nacl.box.open(
      fromBase64(requireString(reply, "message")),
      expected,
      serverKey,
      this.keys.secretKey,
    );
    if (!plain) throw new KpxError("failed to decrypt KeePassXC reply");

    const inner = JSON.parse(Buffer.from(plain).toString("utf8")) as Message;
    throwIfError(inner);
    return inner;
  }

  private async roundTrip(action: string, frame: Message, timeoutMs: number): Promise<Message> {
    this.channel.send(frame);
    return waitForMessage(this.channel, timeoutMs, (message) => message.action === action);
  }

  private requireServerKey(): Uint8Array {
    if (!this.serverPublicKey) throw new KpxError("key exchange with KeePassXC has not been done");
    return this.serverPublicKey;
  }
}
