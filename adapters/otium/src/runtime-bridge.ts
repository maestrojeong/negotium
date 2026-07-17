/** Worker-side runtime MCP mutations that must execute on Otium's canonical hub. */

import { randomUUID } from "node:crypto";

import {
  errorResult,
  logger,
  type McpToolResult,
  type PeerRuntimeBridge,
  resolveAttachmentByFileId,
  resolveUploadedFilePathByFileId,
} from "@negotium/core";
import { mintPeerToken, resolvePeerNodeByCellId } from "@/central";
import { getActiveForwarder } from "@/event-backflow";

const PEER_BRIDGE_TIMEOUT_MS = 15_000;

function isMcpToolResult(value: unknown): value is McpToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<McpToolResult>;
  return (
    Array.isArray(result.content) &&
    result.content.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string",
    ) &&
    (result.isError === undefined || result.isError === true)
  );
}

export const otiumPeerRuntimeBridge = {
  async flushEvents(localTopicId) {
    const forwarder = getActiveForwarder(localTopicId);
    if (!forwarder) return false;
    await forwarder.chain;
    return !forwarder.deliveryBlocked;
  },
  async spawnSubagent(request) {
    const hubNode = await resolvePeerNodeByCellId(request.bridge.hubCellId).catch(() => null);
    if (!hubNode) return errorResult("Error: Hub node is no longer attached.");

    let token: string;
    try {
      token = await mintPeerToken(hubNode.cellId);
    } catch (err) {
      return errorResult(`Error: Failed to spawn on hub: ${(err as Error).message}`);
    }

    let response: Response;
    try {
      response = await fetch(`${hubNode.baseUrl.replace(/\/+$/, "")}/api/v1/peer/bridge/spawn`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostQueryId: request.bridge.hostQueryId,
          userId: request.userId,
          agent: request.agent,
          ...(request.model ? { model: request.model } : {}),
          input: request.input,
        }),
        signal: AbortSignal.timeout(PEER_BRIDGE_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn({ err, node: hubNode.nodeName }, "otium: spawn bridge hub unreachable");
      return errorResult(
        `Error: Failed to spawn on hub: node "${hubNode.nodeName ?? hubNode.cellId}" unreachable`,
      );
    }

    const parsed = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      result?: unknown;
    } | null;
    if (!response.ok || !parsed?.ok) {
      return errorResult(
        `Error: Failed to spawn on hub: ${parsed?.error ?? `peer call failed (${response.status})`}`,
      );
    }
    if (!isMcpToolResult(parsed.result)) {
      return errorResult("Error: Failed to spawn on hub: invalid tool result");
    }
    return parsed.result;
  },
  async askUser(request) {
    const hubNode = await resolvePeerNodeByCellId(request.bridge.hubCellId).catch(() => null);
    if (!hubNode) return errorResult("Error: Hub node is no longer attached.");
    let token: string;
    try {
      token = await mintPeerToken(hubNode.cellId);
    } catch (error) {
      return errorResult(`Error: Failed to open hub question: ${(error as Error).message}`);
    }
    const bridgeRequestId = `bridge-ask-${randomUUID()}`;
    const baseUrl = hubNode.baseUrl.replace(/\/+$/, "");
    const post = async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PEER_BRIDGE_TIMEOUT_MS),
      });
      const parsed = (await response.json().catch(() => null)) as {
        ok?: boolean;
        pending?: boolean;
        result?: unknown;
        error?: string;
      } | null;
      return { response, parsed };
    };
    try {
      const started = await post("/api/v1/peer/bridge/ask/start", {
        hostQueryId: request.bridge.hostQueryId,
        bridgeRequestId,
        userId: request.userId,
        agent: request.agent,
        ...(request.model ? { model: request.model } : {}),
        input: request.input,
      });
      if (!started.response.ok || !started.parsed?.ok) {
        return errorResult(
          `Error: Failed to open hub question: ${started.parsed?.error ?? `peer call failed (${started.response.status})`}`,
        );
      }
      for (;;) {
        await Bun.sleep(500);
        const polled = await post("/api/v1/peer/bridge/ask/result", {
          hostQueryId: request.bridge.hostQueryId,
          bridgeRequestId,
        });
        if (!polled.response.ok || !polled.parsed?.ok) {
          return errorResult(
            `Error: Failed to read hub answer: ${polled.parsed?.error ?? `peer call failed (${polled.response.status})`}`,
          );
        }
        if (polled.parsed.pending !== false) continue;
        if (!isMcpToolResult(polled.parsed.result)) {
          return errorResult("Error: Failed to read hub answer: invalid tool result");
        }
        return polled.parsed.result;
      }
    } catch (error) {
      return errorResult(`Error: Hub question bridge failed: ${(error as Error).message}`);
    }
  },
  async selfConfig(request) {
    const hubNode = await resolvePeerNodeByCellId(request.bridge.hubCellId).catch(() => null);
    if (!hubNode) return errorResult("Error: Hub node is no longer attached.");
    try {
      const token = await mintPeerToken(hubNode.cellId);
      const response = await fetch(
        `${hubNode.baseUrl.replace(/\/+$/, "")}/api/v1/peer/bridge/self-config`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostQueryId: request.bridge.hostQueryId,
            userId: request.userId,
            tool: request.tool,
            input: request.input,
            ...(request.currentUserPrompt ? { currentUserPrompt: request.currentUserPrompt } : {}),
          }),
          signal: AbortSignal.timeout(PEER_BRIDGE_TIMEOUT_MS),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        result?: unknown;
        error?: string;
      } | null;
      if (!response.ok || !body?.ok) {
        return errorResult(
          `Error: Failed to update hub topic config: ${body?.error ?? `peer call failed (${response.status})`}`,
        );
      }
      return isMcpToolResult(body.result)
        ? body.result
        : errorResult("Error: Failed to update hub topic config: invalid tool result");
    } catch (error) {
      return errorResult(`Error: Hub self-config bridge failed: ${(error as Error).message}`);
    }
  },
  async showVisual(request) {
    const hubNode = await resolvePeerNodeByCellId(request.bridge.hubCellId).catch(() => null);
    if (!hubNode) return { ok: false, error: "hub node is no longer attached" };
    let token: string;
    try {
      token = await mintPeerToken(hubNode.cellId);
    } catch (error) {
      return { ok: false, error: `peer token mint failed: ${(error as Error).message}` };
    }

    let hubFileId = request.fileId;
    if (request.kind === "image" || request.kind === "video") {
      const localPath = request.fileId ? resolveUploadedFilePathByFileId(request.fileId) : null;
      const localAttachment = request.fileId ? resolveAttachmentByFileId(request.fileId) : null;
      if (!localPath || !localAttachment) {
        return { ok: false, error: "worker media file is unavailable" };
      }
      const form = new FormData();
      form.set("hostQueryId", request.bridge.hostQueryId);
      form.set("userId", request.userId);
      form.set("agent", request.agent);
      if (request.model) form.set("model", request.model);
      form.set("announce", "false");
      form.set(
        "file",
        Bun.file(localPath, { type: localAttachment.mimeType }),
        localAttachment.filename,
      );
      const fileResponse = await fetch(
        `${hubNode.baseUrl.replace(/\/+$/, "")}/api/v1/peer/bridge/file`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: form,
          signal: AbortSignal.timeout(PEER_BRIDGE_TIMEOUT_MS),
        },
      ).catch(() => null);
      const fileBody = fileResponse
        ? ((await fileResponse.json().catch(() => null)) as {
            ok?: boolean;
            error?: string;
            attachment?: { id?: string };
          } | null)
        : null;
      if (!fileResponse?.ok || !fileBody?.ok || !fileBody.attachment?.id) {
        return { ok: false, error: fileBody?.error ?? "hub media upload failed" };
      }
      hubFileId = fileBody.attachment.id;
    }

    const response = await fetch(
      `${hubNode.baseUrl.replace(/\/+$/, "")}/api/v1/peer/bridge/visual`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostQueryId: request.bridge.hostQueryId,
          userId: request.userId,
          kind: request.kind,
          ...(request.title ? { title: request.title } : {}),
          ...(request.html ? { html: request.html } : {}),
          ...(request.code ? { code: request.code } : {}),
          ...(request.theme ? { theme: request.theme } : {}),
          ...(hubFileId ? { fileId: hubFileId } : {}),
          ...(request.mimeType ? { mimeType: request.mimeType } : {}),
          ...(request.source ? { source: request.source } : {}),
        }),
        signal: AbortSignal.timeout(PEER_BRIDGE_TIMEOUT_MS),
      },
    ).catch(() => null);
    const body = response
      ? ((await response.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          id?: number;
          url?: string;
          title?: string | null;
        } | null)
      : null;
    if (!response?.ok || !body?.ok || typeof body.id !== "number" || !body.url) {
      return { ok: false, error: body?.error ?? "hub visual bridge failed" };
    }
    return { ok: true, id: body.id, url: body.url, title: body.title ?? null };
  },
  async sendFile(request) {
    const hubNode = await resolvePeerNodeByCellId(request.bridge.hubCellId).catch(() => null);
    if (!hubNode) return { ok: false, error: "hub node is no longer attached" };
    try {
      const token = await mintPeerToken(hubNode.cellId);
      const form = new FormData();
      form.set("hostQueryId", request.bridge.hostQueryId);
      form.set("userId", request.userId);
      form.set("agent", request.agent);
      if (request.model) form.set("model", request.model);
      form.set("announce", "true");
      form.set("file", Bun.file(request.path), request.path.split("/").pop() ?? "output");
      const response = await fetch(
        `${hubNode.baseUrl.replace(/\/+$/, "")}/api/v1/peer/bridge/file`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: form,
          signal: AbortSignal.timeout(PEER_BRIDGE_TIMEOUT_MS),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      return response.ok && body?.ok
        ? { ok: true }
        : { ok: false, error: body?.error ?? `peer call failed (${response.status})` };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  },
} satisfies PeerRuntimeBridge;
