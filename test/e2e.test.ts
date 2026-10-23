import { describe, expect, it } from "vitest";
import { connect } from "../src/client.js";
import { createLogger } from "../src/output.js";

// Run manually: KPX_E2E=1 pnpm test. Requires KeePassXC running on Windows.
describe.skipIf(process.env.KPX_E2E !== "1")("e2e: real KeePassXC", () => {
  it("connects to the proxy and gets the KeePassXC version", async () => {
    const session = await connect({ logger: createLogger(true, () => undefined) });
    try {
      expect(session.version).toBeTypeOf("string");
    } finally {
      session.close();
    }
  });
});
