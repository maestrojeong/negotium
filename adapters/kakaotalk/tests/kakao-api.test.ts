import { afterEach, describe, expect, test } from "bun:test";
import { postKakaoCallback } from "@/kakao-api";

describe("postKakaoCallback", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("POSTs a valid Open Builder skill-response body to the callback URL", async () => {
    let received: { method: string; contentType: string | null; body: unknown } | undefined;
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        received = {
          method: req.method,
          contentType: req.headers.get("content-type"),
          body: await req.json(),
        };
        return new Response("ok", { status: 200 });
      },
    });

    await postKakaoCallback(`http://127.0.0.1:${server.port}/callback`, "안녕하세요, lumi예요.");

    expect(received?.method).toBe("POST");
    expect(received?.contentType).toContain("application/json");
    // Shape Open Builder expects back: version 2.0 + a simpleText output —
    // same `kakaoTextResponse` shape the webhook's own sync ack uses.
    expect(received?.body).toEqual({
      version: "2.0",
      template: { outputs: [{ simpleText: { text: "안녕하세요, lumi예요." } }] },
    });
  });

  test("throws when the callback endpoint rejects the request", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("nope", { status: 410 });
      },
    });

    await expect(
      postKakaoCallback(`http://127.0.0.1:${server.port}/callback`, "too late"),
    ).rejects.toThrow(/410/);
  });
});
