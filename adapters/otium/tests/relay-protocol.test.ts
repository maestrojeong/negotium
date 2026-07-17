import { describe, expect, test } from "bun:test";
import {
  decodeNodeFrame,
  decodeRelayFrame,
  encodeFrame,
  fromB64,
  MAX_CHUNK_BYTES,
  MAX_ENCODED_CHUNK_CHARS,
  MAX_HEADER_BYTES,
  MAX_HEADER_PAIRS,
  MAX_ID_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PATH_BYTES,
  MAX_REASON_BYTES,
  type NodeToRelayFrame,
  PROTOCOL_VERSION,
  toB64,
} from "@/relay-protocol";

describe("relay protocol frame validation", () => {
  test("accepts valid node and relay frames", () => {
    expect(
      decodeNodeFrame(
        JSON.stringify({
          type: "http_res_head",
          id: "request-1",
          status: 200,
          headers: [["content-type", "application/json"]],
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "http_req_head",
          id: "request-1",
          method: "POST",
          path: "/api/v1/turns?stream=1",
          headers: [["authorization", "Bearer token"]],
          hasBody: true,
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "registered",
          nodeId: "cell-1",
          protocolVersion: PROTOCOL_VERSION,
          pingIntervalMs: 30_000,
        }),
      ),
    ).not.toBeNull();
  });

  test("rejects malformed required fields and unsafe variants", () => {
    const invalidNodeFrames: unknown[] = [
      null,
      new Uint8Array(),
      "not json",
      JSON.stringify([]),
      JSON.stringify({ type: "unknown" }),
      JSON.stringify({ type: "register" }),
      JSON.stringify({ type: "register", protocolVersion: "2" }),
      JSON.stringify({ type: "pong", ts: "now" }),
      JSON.stringify({ type: "http_res_head", id: "id", status: 200 }),
      JSON.stringify({ type: "http_res_head", id: "id", status: 200, headers: null }),
      JSON.stringify({ type: "http_res_chunk", id: "id" }),
      JSON.stringify({ type: "http_res_chunk", id: "id", dataB64: "not-base64" }),
      JSON.stringify({ type: "http_res_end" }),
      JSON.stringify({ type: "http_res_error", id: "id" }),
      JSON.stringify({ type: "ws_open_ok", id: "" }),
      JSON.stringify({ type: "ws_data", id: "id" }),
      JSON.stringify({ type: "ws_data", id: "id", text: "a", dataB64: "Yg==" }),
      JSON.stringify({ type: "ws_close", id: "id", reason: 123 }),
    ];
    for (const raw of invalidNodeFrames) expect(decodeNodeFrame(raw)).toBeNull();

    const invalidRelayFrames = [
      JSON.stringify({ type: "registered", nodeId: "cell", protocolVersion: 2 }),
      JSON.stringify({ type: "register_error", code: "other", message: "bad" }),
      JSON.stringify({ type: "ping", ts: "now" }),
      JSON.stringify({ type: "http_req_head", id: "id", method: "GET", headers: [] }),
      JSON.stringify({
        type: "http_req_head",
        id: "id",
        method: "GET",
        path: "https://unexpected.example/",
        headers: [],
        hasBody: false,
      }),
      JSON.stringify({
        type: "http_req_head",
        id: "id",
        method: "GET",
        path: "/",
        headers: [["bad header", "value"]],
        hasBody: false,
      }),
      JSON.stringify({ type: "http_req_chunk", id: "id", dataB64: 123 }),
      JSON.stringify({ type: "http_req_end" }),
      JSON.stringify({ type: "http_req_abort", id: "" }),
      JSON.stringify({ type: "ws_open", id: "id", headers: [] }),
      JSON.stringify({ type: "ws_open", id: "id", path: "/ws", headers: {} }),
      JSON.stringify({ type: "ws_data", id: "id", text: null }),
      JSON.stringify({ type: "ws_close", id: "", code: 1000 }),
    ];
    for (const raw of invalidRelayFrames) expect(decodeRelayFrame(raw)).toBeNull();
  });

  test("enforces payload, header, id, path, and string boundaries", () => {
    const chunkAtLimit = Buffer.alloc(MAX_CHUNK_BYTES).toString("base64");
    const chunkOverLimit = Buffer.alloc(MAX_CHUNK_BYTES + 1).toString("base64");
    const encodedOverLimit = "AAAA".repeat(MAX_ENCODED_CHUNK_CHARS / 4 + 1);
    expect(
      decodeRelayFrame(JSON.stringify({ type: "http_req_chunk", id: "id", dataB64: chunkAtLimit })),
    ).not.toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({ type: "http_req_chunk", id: "id", dataB64: chunkOverLimit }),
      ),
    ).toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({ type: "http_req_chunk", id: "id", dataB64: encodedOverLimit }),
      ),
    ).toBeNull();

    const headersAtCount = Array.from({ length: MAX_HEADER_PAIRS }, (_, index) => [
      `x-${index}`,
      "v",
    ]);
    expect(
      decodeRelayFrame(
        JSON.stringify({ type: "ws_open", id: "id", path: "/", headers: headersAtCount }),
      ),
    ).not.toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "ws_open",
          id: "id",
          path: "/",
          headers: [...headersAtCount, ["x-over", "v"]],
        }),
      ),
    ).toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "ws_open",
          id: "id",
          path: "/",
          headers: [["x", "v".repeat(MAX_HEADER_BYTES - 1)]],
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "ws_open",
          id: "id",
          path: "/",
          headers: [["x", "v".repeat(MAX_HEADER_BYTES)]],
        }),
      ),
    ).toBeNull();

    expect(
      decodeRelayFrame(JSON.stringify({ type: "http_req_end", id: "i".repeat(MAX_ID_BYTES) })),
    ).not.toBeNull();
    expect(
      decodeRelayFrame(JSON.stringify({ type: "http_req_end", id: "i".repeat(MAX_ID_BYTES + 1) })),
    ).toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "ws_open",
          id: "id",
          path: `/${"p".repeat(MAX_PATH_BYTES - 1)}`,
          headers: [],
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "ws_open",
          id: "id",
          path: `/${"p".repeat(MAX_PATH_BYTES)}`,
          headers: [],
        }),
      ),
    ).toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({ type: "ws_data", id: "id", text: "t".repeat(MAX_CHUNK_BYTES) }),
      ),
    ).not.toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({ type: "ws_data", id: "id", text: "t".repeat(MAX_CHUNK_BYTES + 1) }),
      ),
    ).toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "register_error",
          code: "unauthorized",
          message: "m".repeat(MAX_MESSAGE_BYTES + 1),
        }),
      ),
    ).toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "ws_close",
          id: "id",
          reason: "r".repeat(MAX_REASON_BYTES),
        }),
      ),
    ).not.toBeNull();
    expect(
      decodeRelayFrame(
        JSON.stringify({
          type: "ws_close",
          id: "id",
          reason: "r".repeat(MAX_REASON_BYTES + 1),
        }),
      ),
    ).toBeNull();
  });

  test("encoder and payload helpers enforce the decoder limits", () => {
    const exact = Buffer.alloc(MAX_CHUNK_BYTES).toString("base64");
    const oversized = Buffer.alloc(MAX_CHUNK_BYTES + 1).toString("base64");
    const valid: NodeToRelayFrame = { type: "http_res_chunk", id: "id", dataB64: exact };
    const invalid = { type: "http_res_chunk", id: "id", dataB64: oversized } as NodeToRelayFrame;
    const oversizedAfterEscaping: NodeToRelayFrame = {
      type: "ws_data",
      id: "id",
      text: "\0".repeat(MAX_CHUNK_BYTES),
    };

    expect(decodeNodeFrame(encodeFrame(valid))).toEqual(valid);
    expect(() => encodeFrame(invalid)).toThrow(TypeError);
    expect(() => encodeFrame(oversizedAfterEscaping)).toThrow(TypeError);
    expect(fromB64(exact)).toHaveLength(MAX_CHUNK_BYTES);
    expect(() => fromB64(oversized)).toThrow(RangeError);
    expect(() => toB64(Buffer.alloc(MAX_CHUNK_BYTES + 1))).toThrow(RangeError);
  });

  test("rejects header injection and invalid optional field types", () => {
    expect(
      decodeNodeFrame(
        JSON.stringify({
          type: "http_res_head",
          id: "id",
          status: 200,
          headers: [["x-test", "ok\r\nx-injected: yes"]],
        }),
      ),
    ).toBeNull();
    expect(
      decodeNodeFrame(JSON.stringify({ type: "register", protocolVersion: 2, nodeVersion: 123 })),
    ).toBeNull();
    expect(
      decodeRelayFrame(JSON.stringify({ type: "ws_close", id: "id", code: 1000, reason: 123 })),
    ).toBeNull();
  });
});
