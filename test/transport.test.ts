import { describe, expect, it } from "vitest";
import { FrameParser, encodeFrame } from "../src/transport.js";

describe("FrameParser", () => {
  it("assembles a frame received in parts", () => {
    const frame = encodeFrame({ action: "get-databasehash", hash: "abc" });
    const parser = new FrameParser();

    expect(parser.push(frame.subarray(0, 2))).toEqual([]);
    expect(parser.push(frame.subarray(2, 7))).toEqual([]);
    expect(parser.push(frame.subarray(7))).toEqual([{ action: "get-databasehash", hash: "abc" }]);
  });

  it("parses several frames in one chunk", () => {
    const parser = new FrameParser();
    const chunk = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })]);

    expect(parser.push(chunk)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("writes the length as uint32 little-endian and counts UTF-8 bytes", () => {
    const frame = encodeFrame({ text: "pässwörd" });
    const body = Buffer.from(JSON.stringify({ text: "pässwörd" }), "utf8");

    expect(frame.readUInt32LE(0)).toBe(body.length);
    expect(frame.subarray(4)).toEqual(body);
  });
});
