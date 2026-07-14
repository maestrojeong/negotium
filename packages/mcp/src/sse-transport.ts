import { randomUUID } from "node:crypto";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  type MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * SSE transport for Claude SDK clients that speak the older two-endpoint
 * protocol (GET /sse to open the stream, POST /message to send).
 *
 * Ported from otium runtime-api `mcp/sse-transport.ts` for the negotium MCP
 * endpoint so fixes to framing, back-pressure, or abort handling stay shared.
 */
export class SseTransport implements Transport {
  readonly sessionId = randomUUID();
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  private readonly encoder = new TextEncoder();
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  private readonly stream: ReadableStream<Uint8Array>;
  private keepAliveTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly endpoint: string,
    req?: Request,
    private readonly keepAliveMs = 20_000,
  ) {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        void this.close();
      },
    });
    req?.signal.addEventListener("abort", () => {
      void this.close();
    });
  }

  response(): Response {
    return new Response(this.stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  async start(): Promise<void> {
    if (this.closed) return;
    const url = new URL(this.endpoint, "http://localhost");
    url.searchParams.set("sessionId", this.sessionId);
    this.enqueue(`event: endpoint\ndata: ${url.pathname}${url.search}${url.hash}\n\n`);
    this.startKeepAlive();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    this.enqueue(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async handleMessage(raw: unknown, req: Request): Promise<void> {
    const parsed = JSONRPCMessageSchema.parse(raw);
    this.onmessage?.(parsed, {
      requestInfo: {
        headers: Object.fromEntries(req.headers.entries()),
        url: new URL(req.url),
      },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.controller?.close();
    } catch {
      // Client already closed the stream.
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    this.onclose?.();
  }

  private startKeepAlive(): void {
    if (this.closed || this.keepAliveTimer || this.keepAliveMs <= 0) return;
    this.keepAliveTimer = setInterval(() => {
      this.enqueue(": ping\n\n");
    }, this.keepAliveMs);
  }

  private enqueue(payload: string): void {
    if (this.closed) return;
    try {
      this.controller?.enqueue(this.encoder.encode(payload));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onerror?.(error);
      void this.close();
    }
  }
}
