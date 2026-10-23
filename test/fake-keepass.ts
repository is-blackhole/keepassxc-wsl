import { EventEmitter } from "node:events";
import nacl from "tweetnacl";
import { incrementNonce } from "../src/protocol.js";
import type { Channel, Message } from "../src/transport.js";

export interface FakeEntry {
  name: string;
  login: string;
  password: string;
  uuid: string;
  group?: string;
  url: string;
  expired?: boolean;
  stringFields?: Record<string, string>;
  totp?: string;
}

export interface FakeOptions {
  entries?: FakeEntry[];
  hash?: string;
  locked?: boolean;
  /** Delay before unlocking after triggerUnlock, in ms. */
  unlockDelayMs?: number;
  rejectAssociation?: boolean;
  /** Send database-locked before every reply. */
  noise?: boolean;
  /** Reply with a wrong nonce. */
  wrongNonce?: boolean;
}

const enc = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const dec = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

/** In-memory server side of browser integration, built on tweetnacl. */
export class FakeKeePass extends EventEmitter implements Channel {
  readonly serverKeys = nacl.box.keyPair();
  readonly sent: Message[] = [];
  readonly calls: string[] = [];
  locked: boolean;
  closed = false;

  private clientPublicKey: Uint8Array | undefined;
  private readonly associations = new Map<string, string>();
  private associationCounter = 0;

  constructor(private readonly options: FakeOptions = {}) {
    super();
    this.locked = options.locked ?? false;
  }

  send(message: object): void {
    const frame = message as Message;
    this.sent.push(frame);
    setImmediate(() => {
      for (const reply of this.handle(frame)) this.emit("message", reply);
    });
  }

  close(): void {
    this.closed = true;
  }

  private handle(frame: Message): Message[] {
    const action = String(frame.action);
    const replies: Message[] = [];
    if (this.options.noise) replies.push({ action: "database-locked", success: "true" });

    if (action === "change-public-keys") {
      this.clientPublicKey = dec(String(frame.publicKey));
      replies.push({
        action,
        publicKey: enc(this.serverKeys.publicKey),
        nonce: frame.nonce,
        success: "true",
        version: "2.8.0",
      });
      return replies;
    }

    const clientKey = this.clientPublicKey;
    if (!clientKey) return [...replies, { action, error: "not paired", errorCode: 5 }];

    const requestNonce = dec(String(frame.nonce));
    const plain = nacl.box.open(dec(String(frame.message)), requestNonce, clientKey, this.serverKeys.secretKey);
    if (!plain) return [...replies, { action, error: "cannot decrypt", errorCode: 4 }];

    const inner = JSON.parse(Buffer.from(plain).toString("utf8")) as Message;
    this.calls.push(String(inner.action));
    const body = this.dispatch(inner, frame.triggerUnlock === "true");

    const responseNonce = this.options.wrongNonce ? requestNonce : incrementNonce(requestNonce);
    const cipher = nacl.box(
      Buffer.from(JSON.stringify(body), "utf8"),
      responseNonce,
      clientKey,
      this.serverKeys.secretKey,
    );
    replies.push({ action, message: enc(cipher), nonce: enc(responseNonce) });
    return replies;
  }

  private dispatch(inner: Message, triggerUnlock: boolean): Message {
    const action = String(inner.action);
    if (this.locked && action !== "change-public-keys") {
      if (triggerUnlock) this.scheduleUnlock();
      return { action, error: "Database is closed", errorCode: 1 };
    }

    switch (action) {
      case "get-databasehash":
        return { action, hash: this.options.hash ?? "db-hash-1", success: "true" };

      case "associate": {
        if (this.options.rejectAssociation) return { action, error: "Association denied", errorCode: 6 };
        this.associationCounter++;
        const id = `assoc-${this.associationCounter}`;
        this.associations.set(id, String(inner.idKey));
        return { action, id, hash: this.options.hash ?? "db-hash-1", success: "true" };
      }

      case "test-associate":
        if (this.associations.get(String(inner.id)) !== String(inner.key)) {
          return { action, error: "Association failed", errorCode: 8 };
        }
        return { action, id: inner.id, success: "true" };

      case "get-logins":
        return this.getLogins(inner);

      case "get-database-entries":
        return this.getDatabaseEntries(inner);

      case "get-totp": {
        const entry = this.entries().find((candidate) => candidate.uuid === inner.uuid);
        if (!entry?.totp) return { action, error: "No TOTP", errorCode: 15 };
        return { action, totp: entry.totp, success: "true" };
      }

      default:
        return { action, error: "Incorrect action", errorCode: 12 };
    }
  }

  private getLogins(inner: Message): Message {
    const action = "get-logins";
    const keys = (inner.keys as Array<{ id: string; key: string }>) ?? [];
    const authorized = keys.some((key) => this.associations.get(key.id) === key.key);
    if (!authorized) return { action, error: "Association failed", errorCode: 8 };

    const matches = this.entries().filter((entry) => entry.url === inner.url);
    if (matches.length === 0) return { action, error: "No logins found", errorCode: 15 };

    return {
      action,
      count: matches.length,
      success: "true",
      entries: matches.map((entry) => ({
        name: entry.name,
        login: entry.login,
        password: entry.password,
        uuid: entry.uuid,
        group: entry.group ?? "Root",
        expired: entry.expired ? "true" : "false",
        stringFields: Object.entries(entry.stringFields ?? {}).map(([key, value]) => ({
          [`KPH: ${key}`]: value,
        })),
        ...(entry.totp ? { totp: entry.totp } : {}),
      })),
    };
  }

  private getDatabaseEntries(inner: Message): Message {
    const action = "get-database-entries";
    const keys = (inner.keys as Array<{ id: string; key: string }>) ?? [];
    const authorized = keys.some((key) => this.associations.get(key.id) === key.key);
    if (!authorized) return { action, error: "Association failed", errorCode: 8 };

    return {
      action,
      success: "true",
      entries: this.entries().map((entry) => ({
        title: entry.name,
        uuid: entry.uuid,
        url: entry.url,
      })),
    };
  }

  private scheduleUnlock(): void {
    setTimeout(() => {
      this.locked = false;
      this.emit("message", { action: "database-unlocked", success: "true" });
    }, this.options.unlockDelayMs ?? 10);
  }

  private entries(): FakeEntry[] {
    return this.options.entries ?? [];
  }
}
