export const RUNTIME_GATEWAY_VERSION = 1 as const;
export const RUNTIME_GATEWAY_CONTROL_PATH = "/api/v1/control/runtime/v1";

export type RuntimeGatewayErrorKind = "config" | "timeout" | "transport" | "protocol" | "http";

export class RuntimeGatewayError extends Error {
  constructor(
    message: string,
    public readonly kind: RuntimeGatewayErrorKind,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export interface RuntimeGatewayHealth {
  ok: true;
  v: typeof RUNTIME_GATEWAY_VERSION;
  nodeId?: string;
  aiName?: string;
  capabilities: string[];
  cursor: number;
}

export interface RuntimeGatewayTurnInput {
  topicId: string;
  /** Canonical principal on the execution node. */
  userId: string;
  /** Product-side actor, when it differs from the execution principal. */
  actorUserId?: string;
  actorLabel?: string;
  vaultUserId?: string;
  text: string;
  clientMessageId: string;
  requestId?: string;
  allowAutoContinue?: boolean;
  threadRootId?: string;
  respond?: boolean;
  attachments?: string[];
  visualTools?: boolean;
  fileDeliveryTools?: boolean;
}

export interface RuntimeGatewayTurnAcknowledgement {
  ok: true;
  v: typeof RUNTIME_GATEWAY_VERSION;
  accepted: true;
  deduplicated: boolean;
  requestId: string;
  clientMessageId: string;
  topicId: string;
  messageId: string;
  cursor: number;
}

export interface RuntimeGatewaySseEvent {
  id?: number;
  event: string;
  data: unknown;
}

export interface RuntimeGatewayTopicUsage {
  queries: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  estimatedCostUsd: number;
}

export type RuntimeGatewayToken = string | (() => string | Promise<string>);
export type RuntimeGatewayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RuntimeGatewayClientOptions {
  baseUrl: string;
  token: RuntimeGatewayToken;
  /** Loopback control path or an authenticated relay forward prefix. */
  pathPrefix?: string;
  fetch?: RuntimeGatewayFetch;
  requestTimeoutMs?: number;
  compactTimeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new RuntimeGatewayError(
      "Runtime Gateway returned invalid JSON",
      "protocol",
      response.status,
    );
  }
}

function validHealth(value: unknown): value is RuntimeGatewayHealth {
  const body = record(value);
  return Boolean(
    body?.ok === true &&
      body.v === RUNTIME_GATEWAY_VERSION &&
      Array.isArray(body.capabilities) &&
      typeof body.cursor === "number",
  );
}

function validTurnAck(value: unknown): value is RuntimeGatewayTurnAcknowledgement {
  const body = record(value);
  return Boolean(
    body?.ok === true &&
      body.v === RUNTIME_GATEWAY_VERSION &&
      body.accepted === true &&
      typeof body.deduplicated === "boolean" &&
      typeof body.requestId === "string" &&
      typeof body.clientMessageId === "string" &&
      typeof body.topicId === "string" &&
      typeof body.messageId === "string" &&
      typeof body.cursor === "number",
  );
}

export async function* parseRuntimeGatewaySse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RuntimeGatewaySseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let id: number | undefined;
  let data: string[] = [];
  const flush = (): RuntimeGatewaySseEvent | null => {
    if (data.length === 0) return null;
    const raw = data.join("\n");
    data = [];
    try {
      return { event, id, data: JSON.parse(raw) };
    } catch {
      throw new RuntimeGatewayError("Runtime Gateway SSE event has invalid JSON", "protocol");
    } finally {
      event = "message";
      id = undefined;
    }
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          const parsed = flush();
          if (parsed) yield parsed;
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim() || "message";
        } else if (line.startsWith("id:")) {
          const parsed = Number.parseInt(line.slice(3).trim(), 10);
          if (Number.isFinite(parsed)) id = parsed;
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
    const parsed = flush();
    if (parsed) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

export class RuntimeGatewayClient {
  private readonly pathPrefix: string;
  private readonly request: RuntimeGatewayFetch;
  private readonly requestTimeoutMs: number;
  private readonly compactTimeoutMs: number;

  constructor(private readonly options: RuntimeGatewayClientOptions) {
    this.pathPrefix = options.pathPrefix ?? RUNTIME_GATEWAY_CONTROL_PATH;
    this.request = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.compactTimeoutMs = options.compactTimeoutMs ?? 5 * 60_000;
  }

  private endpoint(path: string): string {
    if (!this.options.baseUrl || !this.options.token) {
      throw new RuntimeGatewayError("Runtime Gateway is not configured", "config");
    }
    return `${this.options.baseUrl.replace(/\/+$/, "")}${this.pathPrefix}${path}`;
  }

  private async authorization(): Promise<string> {
    try {
      const token =
        typeof this.options.token === "function" ? await this.options.token() : this.options.token;
      return `Bearer ${token}`;
    } catch (error) {
      throw new RuntimeGatewayError(
        error instanceof Error ? error.message : "Runtime Gateway token resolution failed",
        "config",
      );
    }
  }

  private async send(path: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
    const authorization = await this.authorization();
    try {
      return await this.request(this.endpoint(path), {
        ...init,
        headers: { authorization, ...init.headers },
        signal: timeoutMs === undefined ? init.signal : AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new RuntimeGatewayError("Runtime Gateway request timed out", "timeout");
      }
      throw new RuntimeGatewayError("Runtime Gateway request failed", "transport");
    }
  }

  async health(): Promise<RuntimeGatewayHealth> {
    const response = await this.send("/health", { method: "GET" }, this.requestTimeoutMs);
    if (!response.ok) {
      throw new RuntimeGatewayError(
        "Runtime Gateway health request failed",
        "http",
        response.status,
      );
    }
    const body = await json(response);
    if (!validHealth(body)) {
      throw new RuntimeGatewayError("Runtime Gateway health response is incompatible", "protocol");
    }
    return body;
  }

  async submitTurn(input: RuntimeGatewayTurnInput): Promise<RuntimeGatewayTurnAcknowledgement> {
    const response = await this.send(
      "/turns",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: RUNTIME_GATEWAY_VERSION, ...input }),
      },
      this.requestTimeoutMs,
    );
    if (response.status !== 202) {
      throw new RuntimeGatewayError(
        "Runtime Gateway turn was not accepted",
        "http",
        response.status,
      );
    }
    const body = await json(response);
    if (!validTurnAck(body)) {
      throw new RuntimeGatewayError(
        "Runtime Gateway turn acknowledgement is incompatible",
        "protocol",
      );
    }
    return body;
  }

  async *events(
    after: number,
    topicId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeGatewaySseEvent> {
    const search = new URLSearchParams({ after: String(Math.max(0, after)) });
    if (topicId) search.set("topicId", topicId);
    const response = await this.send(`/events?${search}`, { method: "GET", signal });
    if (!response.ok || !response.body) {
      throw new RuntimeGatewayError("Runtime Gateway event stream failed", "http", response.status);
    }
    yield* parseRuntimeGatewaySse(response.body);
  }

  async getTopicUsage(topicId: string, userId: string): Promise<RuntimeGatewayTopicUsage> {
    const response = await this.send(
      `/topics/${encodeURIComponent(topicId)}/usage?user=${encodeURIComponent(userId)}`,
      { method: "GET" },
      this.requestTimeoutMs,
    );
    if (!response.ok) {
      throw new RuntimeGatewayError(
        "Runtime Gateway topic usage request failed",
        "http",
        response.status,
      );
    }
    const usage = record(record(await json(response))?.usage);
    const read = (key: keyof RuntimeGatewayTopicUsage): number => {
      const value = usage?.[key];
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    };
    return {
      queries: read("queries"),
      inputTokens: read("inputTokens"),
      outputTokens: read("outputTokens"),
      cacheCreationInputTokens: read("cacheCreationInputTokens"),
      cacheReadInputTokens: read("cacheReadInputTokens"),
      estimatedCostUsd: read("estimatedCostUsd"),
    };
  }

  async abortTurn(topicId: string, userId: string): Promise<boolean> {
    const response = await this.send(
      `/topics/${encodeURIComponent(topicId)}/abort`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: RUNTIME_GATEWAY_VERSION, userId }),
      },
      this.requestTimeoutMs,
    );
    if (!response.ok) {
      throw new RuntimeGatewayError("Runtime Gateway turn abort failed", "http", response.status);
    }
    const body = record(await json(response));
    if (
      body?.ok !== true ||
      body.v !== RUNTIME_GATEWAY_VERSION ||
      typeof body.aborted !== "boolean"
    ) {
      throw new RuntimeGatewayError(
        "Runtime Gateway turn abort response is incompatible",
        "protocol",
      );
    }
    return body.aborted;
  }

  async resetSession(
    topicId: string,
    userId: string,
    reason?: string,
  ): Promise<string | undefined> {
    return this.sessionCommand(topicId, userId, "reset", reason);
  }

  async compactSession(
    topicId: string,
    userId: string,
    reason?: string,
  ): Promise<string | undefined> {
    return this.sessionCommand(topicId, userId, "compact", reason);
  }

  private async sessionCommand(
    topicId: string,
    userId: string,
    command: "reset" | "compact",
    reason?: string,
  ): Promise<string | undefined> {
    const response = await this.send(
      `/topics/${encodeURIComponent(topicId)}/session/${command}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          v: RUNTIME_GATEWAY_VERSION,
          userId,
          ...(reason ? { reason } : {}),
        }),
      },
      command === "compact" ? this.compactTimeoutMs : this.requestTimeoutMs,
    );
    if (!response.ok) {
      throw new RuntimeGatewayError(
        `Runtime Gateway session ${command} failed`,
        "http",
        response.status,
      );
    }
    const body = record(await json(response));
    if (body?.ok !== true || body.v !== RUNTIME_GATEWAY_VERSION) {
      throw new RuntimeGatewayError(
        `Runtime Gateway session ${command} response is incompatible`,
        "protocol",
      );
    }
    return typeof body.result === "string" ? body.result : undefined;
  }
}
