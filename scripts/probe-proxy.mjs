// Прототип: один change-public-keys через keepassxc-proxy.exe.
// Запуск: pnpm build && node scripts/probe-proxy.mjs
import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import { Transport, waitForMessage, resolveProxyPath } from "../dist/transport.js";

const timeoutMs = Number(process.env.KPX_TIMEOUT ?? 30) * 1000;
const transport = new Transport();
const keys = nacl.box.keyPair();

console.log("proxy:", resolveProxyPath());

try {
  transport.send({
    action: "change-public-keys",
    publicKey: Buffer.from(keys.publicKey).toString("base64"),
    nonce: randomBytes(24).toString("base64"),
    clientID: randomBytes(24).toString("base64"),
  });

  const response = await waitForMessage(
    transport,
    timeoutMs,
    (message) => message.action === "change-public-keys",
  );
  console.log("response:", JSON.stringify(response, null, 2));
} catch (error) {
  console.error("error:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  transport.close();
}
