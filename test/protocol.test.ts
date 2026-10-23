import { describe, expect, it } from "vitest";
import { incrementNonce } from "../src/protocol.js";

describe("incrementNonce", () => {
  it("increments a little-endian value by one", () => {
    expect(Array.from(incrementNonce(new Uint8Array([1, 0, 0])))).toEqual([2, 0, 0]);
  });

  it("carries byte overflow into the next byte", () => {
    expect(Array.from(incrementNonce(new Uint8Array([0xff, 0, 0])))).toEqual([0, 1, 0]);
    expect(Array.from(incrementNonce(new Uint8Array([0xff, 0xff, 0x41])))).toEqual([0, 0, 0x42]);
  });

  it("wraps around to zero on full overflow", () => {
    expect(Array.from(incrementNonce(new Uint8Array([0xff, 0xff, 0xff])))).toEqual([0, 0, 0]);
  });

  it("does not mutate the input nonce", () => {
    const nonce = new Uint8Array([0xff, 1]);
    incrementNonce(nonce);
    expect(Array.from(nonce)).toEqual([0xff, 1]);
  });
});
