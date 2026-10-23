import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export const DEFAULT_PROXY_PATH = "/mnt/c/Program Files/KeePassXC/keepassxc-proxy.exe";

export type Message = Record<string, unknown>;

/** Message channel to KeePassXC: the real proxy or a test fake. */
export interface Channel extends EventEmitter {
  send(message: object): void;
  close(): void;
}

export function resolveProxyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.KPX_PROXY || DEFAULT_PROXY_PATH;
}

export function encodeFrame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Message[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: Message[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      messages.push(JSON.parse(body) as Message);
    }
    return messages;
  }
}

/**
 * Events: "message" (Message), "error" (Error), "close" (code, signal).
 * "error" must have a listener, otherwise EventEmitter throws.
 */
export class Transport extends EventEmitter implements Channel {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly parser = new FrameParser();
  private closed = false;

  constructor(proxyPath: string = resolveProxyPath()) {
    super();
    this.child = spawn(proxyPath, [], { stdio: "pipe" });

    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.parser.push(chunk)) {
          this.emit("message", message);
        }
      } catch (error) {
        this.emit("error", error);
      }
    });

    this.child.stdin.on("error", (error) => this.emit("error", error));

    this.child.on("error", (error) => {
      this.closed = true;
      this.emit("error", new Error(`failed to start keepassxc-proxy (${proxyPath}): ${error.message}`));
    });

    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.emit("close", code, signal);
    });
  }

  send(message: object): void {
    if (this.closed) {
      throw new Error("proxy is not running");
    }
    this.child.stdin.write(encodeFrame(message));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

export function waitForMessage(
  transport: Channel,
  timeoutMs: number,
  match: (message: Message) => boolean = () => true,
): Promise<Message> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      transport.off("message", onMessage);
      transport.off("error", onError);
      transport.off("close", onClose);
    };
    const onMessage = (message: Message): void => {
      if (!match(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null): void => {
      cleanup();
      reject(new Error(`keepassxc-proxy exited with code ${code ?? "unknown"}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`no response from keepassxc-proxy within ${timeoutMs} ms`));
    }, timeoutMs);

    transport.on("message", onMessage);
    transport.on("error", onError);
    transport.on("close", onClose);
  });
}
