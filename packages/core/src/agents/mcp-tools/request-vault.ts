import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { errorResult, type SharedMcpTool, textResult } from "#agents/mcp-tools/common";
import { WsHub } from "#bus";
import { appendApiMessage, getApiMessage } from "#storage/api-messages";
import { getApiTopicConfig } from "#storage/api-topic-config";
import { getTopic } from "#storage/api-topics";
import {
  acquireRuntimeProcessLease,
  isRuntimeProcessLeaseAlive,
  listRuntimeProcessLeases,
  type RuntimeProcessLease,
  type RuntimeProcessLeaseHandle,
  removeDeadRuntimeProcessLeases,
} from "#storage/runtime-process-leases";
import {
  normalizeVaultKey,
  VAULT_DESCRIPTION_MAX_LENGTH,
  VAULT_KEY_PATTERN,
  VAULT_VALUE_MAX_BYTES,
  VAULT_VALUE_MIN_BYTES,
  vaultDel,
  vaultHasKey,
  vaultSet,
} from "#storage/vault";
import {
  type ClaimVaultRequestGateResult,
  cancelVaultRequestGate,
  claimVaultRequestGateAndAnswer,
  type PrepareVaultRequestGateResult,
  prepareVaultRequestGate,
  quarantineForeignVaultRequestGates,
  quarantineVaultRequestGate,
  type VaultRequestGateCardUpdate,
} from "#storage/vault-request-gates";
import type { AgentKind } from "#types";
import type { MessageDto, TopicDto, VaultSecretRequestDto } from "#types/api";

const MAX_DESCRIPTION_CHARS = VAULT_DESCRIPTION_MAX_LENGTH;
const MAX_IDEMPOTENCY_KEY_CHARS = 200;
const VAULT_GATE_OWNER_ID = `request-vault-${process.pid}-${randomUUID()}`;
const VAULT_GATE_LEASE_ROLE_PREFIX = "vault-request-gate:";

export interface RequestVaultToolContext {
  userId: string;
  topicId: string;
  queryId?: string;
  agent: AgentKind;
  model?: string;
  threadRootId?: string;
  /**
   * Set when this turn's surface cannot mask text input (Telegram has no
   * native password field, so anything a person types becomes a plaintext
   * message that lingers in chat history). When true the tool refuses
   * immediately and never creates a card, instead of asking for a secret on
   * a surface that cannot protect it.
   */
  unsupportedSurface?: boolean;
}

export type AnswerVaultSecretRequestResult =
  | { ok: true; queryId?: string; outcome: "fulfilled" | "declined"; answerMessage: MessageDto }
  | { ok: false; error: string };

export interface RequestVaultRuntimeHost {
  messaging: {
    persistence: {
      getMessage(topicId: string, messageId: string): MessageDto | null | undefined;
      appendMessage(message: MessageDto): void;
    };
    publication: {
      publishMessage(topicId: string, message: MessageDto): void;
      publishCardUpdate(update: VaultRequestGateCardUpdate): void;
    };
  };
  topics: {
    getTopic(topicId: string): Pick<TopicDto, "participants"> | null | undefined;
    getConfig(topicId: string): { model?: string } | undefined;
  };
  vault: {
    hasKey(userId: string, key: string): boolean;
    /** Writes the secret. Called before the gate is claimed, so a storage
     * failure never leaves a card marked "fulfilled" without a stored value. */
    set(userId: string, key: string, value: string, description: string): void;
    /** Removes a key outright. Returns false when there was nothing to delete. */
    del(userId: string, key: string): boolean;
  };
  durability: {
    gates: {
      prepare(args: {
        gateId: string;
        topicId: string;
        queryId?: string;
        idempotencyKey: string;
        bodyHash: string;
        messageId: string;
        ownerId: string;
        now: string;
      }): PrepareVaultRequestGateResult;
      claimAndAnswer(args: {
        topicId: string;
        messageId: string;
        outcome: "fulfilled" | "declined";
        userId: string;
        ownerId: string;
        source: string;
        now: string;
      }): ClaimVaultRequestGateResult;
      cancel(
        topicId: string,
        messageId: string,
        ownerId: string,
        now: string,
      ): VaultRequestGateCardUpdate | null;
      quarantine(gateId: string, ownerId: string, now: string): VaultRequestGateCardUpdate | null;
      quarantineForeign(
        liveOwnerIds: ReadonlySet<string>,
        now: string,
      ): VaultRequestGateCardUpdate[];
    };
    processLeases: {
      acquire(role: string, ownerId: string): RuntimeProcessLeaseHandle | null;
      list(rolePrefix: string): RuntimeProcessLease[];
      isAlive(lease: RuntimeProcessLease): boolean;
      removeDead(rolePrefix: string): void;
    };
  };
  runtime: {
    ownerId: string;
    createId(): string;
    now(): string;
  };
}

export interface RequestVaultRuntime {
  startGateOwner(): void;
  stopGateOwner(): void;
  reconcilePendingGates(): number;
  answerPendingRequest(
    topicId: string,
    messageId: string,
    userId: string,
    value: string | null,
  ): AnswerVaultSecretRequestResult;
  cancelPendingRequests(topicId: string, queryId: string): void;
  createToolDefinition(ctx: RequestVaultToolContext): SharedMcpTool;
  createDeleteToolDefinition(ctx: RequestVaultToolContext): SharedMcpTool;
}

type PendingVaultRequest = {
  topicId: string;
  queryId?: string;
  messageId: string;
  key: string;
  description: string;
  promise: Promise<{ outcome: "fulfilled" | "declined" | "no_answer"; userId: string }>;
  resolve: (answer: { outcome: "fulfilled" | "declined" | "no_answer"; userId: string }) => void;
};

function requestBodyHash(key: string, description: string): string {
  return createHash("sha256").update(JSON.stringify({ key, description })).digest("hex");
}

function answerToolResult(key: string, outcome: "fulfilled" | "declined" | "no_answer") {
  if (outcome === "no_answer") {
    return errorResult("The AI turn ended before the user answered.");
  }
  if (outcome === "declined") {
    return errorResult(`User declined to provide a value for ${key}.`);
  }
  return textResult(
    `User stored a value for ${key} in the vault. Reference it as {{${key}}} directly in supported transient tool inputs. Never ask the user to repeat the raw value in chat.`,
  );
}

/**
 * Create an isolated request-vault-secret lifecycle over host-provided
 * messaging, topic, vault, durability, and runtime services. Mirrors
 * `createAskUserRuntime`'s durable-gate shape, but the thing being
 * exchanged is "did the user supply a value", never the value itself.
 */
export function createRequestVaultRuntime(host: RequestVaultRuntimeHost): RequestVaultRuntime {
  const pendingRequests = new Map<string, PendingVaultRequest>();
  const { ownerId } = host.runtime;
  const createId = () => host.runtime.createId();
  const now = () => host.runtime.now();
  const isProcessLeaseAlive = (lease: RuntimeProcessLease) =>
    host.durability.processLeases.isAlive(lease);
  let gateOwnerLease: RuntimeProcessLeaseHandle | null = null;

  function broadcastGateUpdates(updates: VaultRequestGateCardUpdate[]): void {
    for (const update of updates) host.messaging.publication.publishCardUpdate(update);
  }

  function startGateOwner(): void {
    if (gateOwnerLease) return;
    gateOwnerLease = host.durability.processLeases.acquire(
      `${VAULT_GATE_LEASE_ROLE_PREFIX}${ownerId}`,
      ownerId,
    );
    if (!gateOwnerLease) throw new Error("failed to acquire the vault-request gate owner lease");
  }

  function stopGateOwner(): void {
    gateOwnerLease?.stop();
    gateOwnerLease = null;
  }

  function reconcilePendingGates(): number {
    startGateOwner();
    host.durability.processLeases.removeDead(VAULT_GATE_LEASE_ROLE_PREFIX);
    const liveOwners = new Set(
      host.durability.processLeases
        .list(VAULT_GATE_LEASE_ROLE_PREFIX)
        .filter(isProcessLeaseAlive)
        .map((lease) => lease.ownerId),
    );
    const updates = host.durability.gates.quarantineForeign(liveOwners, now());
    broadcastGateUpdates(updates);
    return updates.length;
  }

  function answerPendingRequest(
    topicId: string,
    messageId: string,
    userId: string,
    value: string | null,
  ): AnswerVaultSecretRequestResult {
    reconcilePendingGates();
    const topic = host.topics.getTopic(topicId);
    if (!topic?.participants.some((participant) => participant.userId === userId)) {
      return { ok: false, error: "User is not a member of this topic." };
    }
    const existing = host.messaging.persistence.getMessage(topicId, messageId);
    const request =
      existing?.kind === "vault_secret_request" ? existing.vaultSecretRequest : undefined;
    if (!existing || existing.deleted || !request) {
      return { ok: false, error: "Vault request card not found." };
    }
    if (request.status !== "pending") {
      return { ok: false, error: "This request is no longer awaiting an answer." };
    }
    const pending = pendingRequests.get(messageId);
    if (!pending || pending.topicId !== topicId) {
      return { ok: false, error: "This request is no longer awaiting an answer." };
    }

    const declining = value === null;
    if (!declining) {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes < VAULT_VALUE_MIN_BYTES || bytes > VAULT_VALUE_MAX_BYTES) {
        return {
          ok: false,
          error: `Value must be between ${VAULT_VALUE_MIN_BYTES} and ${VAULT_VALUE_MAX_BYTES} bytes.`,
        };
      }
    }

    // Write the secret (if any) before the gate is claimed: a storage fault
    // here must leave the card still pending, not falsely "fulfilled".
    if (!declining) {
      try {
        host.vault.set(userId, pending.key, value, pending.description);
      } catch (error) {
        return {
          ok: false,
          error: `Failed to store the value: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    const outcome: "fulfilled" | "declined" = declining ? "declined" : "fulfilled";
    let claim: ClaimVaultRequestGateResult;
    try {
      claim = host.durability.gates.claimAndAnswer({
        topicId,
        messageId,
        outcome,
        userId,
        ownerId,
        source: "host-control",
        now: now(),
      });
    } catch {
      return { ok: false, error: "This request could not be claimed safely. Retry once." };
    }
    if (claim.outcome !== "claimed") {
      return { ok: false, error: "This request is no longer awaiting an answer." };
    }
    pendingRequests.delete(messageId);

    const answerMessage: MessageDto = {
      id: createId(),
      topicId,
      authorId: userId,
      text:
        outcome === "fulfilled"
          ? `Provided a value for ${pending.key}.`
          : `Declined to provide a value for ${pending.key}.`,
      parentId: messageId,
      ...(existing.threadRootId ? { threadRootId: existing.threadRootId } : {}),
      createdAt: now(),
    };
    try {
      host.messaging.publication.publishCardUpdate({
        topicId,
        messageId,
        vaultSecretRequest: claim.vaultSecretRequest,
        editedAt: claim.editedAt,
      });
      host.messaging.persistence.appendMessage(answerMessage);
      host.messaging.publication.publishMessage(topicId, answerMessage);
    } catch {
      // The durable answer is authoritative; publication and the convenience
      // child message are best-effort after it.
    }
    pending.resolve({ outcome, userId });
    return { ok: true, queryId: pending.queryId, outcome, answerMessage };
  }

  function cancelPendingRequests(topicId: string, queryId: string): void {
    for (const [messageId, pending] of pendingRequests) {
      if (pending.topicId === topicId && pending.queryId === queryId) {
        pendingRequests.delete(messageId);
        const update = host.durability.gates.cancel(topicId, messageId, ownerId, now());
        if (update) broadcastGateUpdates([update]);
        pending.resolve({ outcome: "no_answer", userId: "" });
      }
    }
  }

  function appendRequestMessage(
    ctx: RequestVaultToolContext,
    key: string,
    description: string,
    messageId: string,
  ): MessageDto {
    const cfg = host.topics.getConfig(ctx.topicId);
    const vaultSecretRequest: VaultSecretRequestDto = { key, description, status: "pending" };
    const message: MessageDto = {
      id: messageId,
      topicId: ctx.topicId,
      authorId: "ai",
      text: `Vault secret requested: ${key}`,
      queryId: ctx.queryId,
      agentType: ctx.agent,
      model: ctx.model ?? cfg?.model ?? "unknown",
      kind: "vault_secret_request",
      vaultSecretRequest,
      ...(ctx.threadRootId ? { threadRootId: ctx.threadRootId } : {}),
      createdAt: now(),
    };
    host.messaging.persistence.appendMessage(message);
    return message;
  }

  async function requestVaultSecret(
    ctx: RequestVaultToolContext,
    input: {
      key?: unknown;
      description?: unknown;
      idempotency_key?: unknown;
      overwrite?: unknown;
    },
  ) {
    if (ctx.unsupportedSurface) {
      return errorResult(
        "Error: this surface cannot mask secret input safely (there is no password field here, so a typed value would land in plaintext chat history). Ask the user to provide this value from the Terminal app or Otium instead.",
      );
    }
    reconcilePendingGates();
    const topic = host.topics.getTopic(ctx.topicId);
    if (!topic) return errorResult(`Error: topic '${ctx.topicId}' not found.`);
    if (!topic.participants.some((participant) => participant.userId === ctx.userId)) {
      return errorResult("Error: user is not a member of this topic.");
    }

    if (typeof input.key !== "string" || !input.key.trim()) {
      return errorResult("Error: key is required.");
    }
    const key = normalizeVaultKey(input.key);
    if (!VAULT_KEY_PATTERN.test(key)) {
      return errorResult(
        "Error: key must start with a letter and contain only uppercase letters, digits, and underscores (max 128 chars).",
      );
    }
    if (typeof input.description !== "string" || !input.description.trim()) {
      return errorResult("Error: description is required so the user knows what to type.");
    }
    const description = input.description.trim().slice(0, MAX_DESCRIPTION_CHARS);
    if (
      input.idempotency_key !== undefined &&
      (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim())
    ) {
      return errorResult("Error: idempotency_key must be a non-empty string.");
    }
    const rawIdempotencyKey =
      typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : createId();
    if (rawIdempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      return errorResult(
        `Error: idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters.`,
      );
    }
    if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") {
      return errorResult("Error: overwrite must be a boolean.");
    }
    const overwrite = input.overwrite === true;

    const bodyHash = requestBodyHash(key, description);
    const createGate = () => {
      const suffix = createId();
      return host.durability.gates.prepare({
        gateId: `vault-request-gate-${suffix}`,
        topicId: ctx.topicId,
        queryId: ctx.queryId,
        idempotencyKey: rawIdempotencyKey,
        bodyHash,
        messageId: `vault-request-${ctx.queryId ?? "runtime"}-${suffix}`,
        ownerId,
        now: now(),
      });
    };

    let prepared = createGate();
    if (prepared.outcome === "conflict") {
      return errorResult(
        "Error: idempotency_conflict. The same idempotency_key was already used with a different key or description.",
      );
    }
    if (prepared.outcome === "replay") {
      if (!prepared.gate.outcome || !prepared.gate.answeredBy) {
        return errorResult("Error: the stored request_vault_secret replay is incomplete.");
      }
      return answerToolResult(key, prepared.gate.outcome);
    }
    if (prepared.outcome === "pending") {
      if (prepared.gate.ownerId !== ownerId) {
        return errorResult(
          "Error: this request_vault_secret is pending in another healthy runtime process.",
        );
      }
      const existingPending = pendingRequests.get(prepared.gate.messageId);
      if (existingPending) return answerToolResult(key, (await existingPending.promise).outcome);
      if (prepared.gate.state === "claimed") {
        return errorResult("Error: this request_vault_secret is already being finalized.");
      }
      const update = host.durability.gates.quarantine(prepared.gate.gateId, ownerId, now());
      if (update) broadcastGateUpdates([update]);
      prepared = createGate();
    }
    if (prepared.outcome !== "created") {
      return errorResult("Error: failed to create a durable request_vault_secret gate.");
    }

    // Checked here, not up front: an idempotent retry of an already-fulfilled
    // request must still replay above, even though the key now exists
    // precisely because that earlier call succeeded.
    if (host.vault.hasKey(ctx.userId, key) && !overwrite) {
      host.durability.gates.quarantine(prepared.gate.gateId, ownerId, now());
      return errorResult(
        `Error: vault key '${key}' already exists. Call again with overwrite: true to replace its value, or pick a different key.`,
      );
    }

    let message: MessageDto;
    try {
      message = appendRequestMessage(ctx, key, description, prepared.gate.messageId);
    } catch (error) {
      host.durability.gates.quarantine(prepared.gate.gateId, ownerId, now());
      return errorResult(
        `Error: failed to persist request_vault_secret: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let resolveAnswer!: (answer: {
      outcome: "fulfilled" | "declined" | "no_answer";
      userId: string;
    }) => void;
    const promise = new Promise<{
      outcome: "fulfilled" | "declined" | "no_answer";
      userId: string;
    }>((resolve) => {
      resolveAnswer = resolve;
    });
    pendingRequests.set(message.id, {
      topicId: ctx.topicId,
      queryId: ctx.queryId,
      messageId: message.id,
      key,
      description,
      promise,
      resolve: resolveAnswer,
    });
    try {
      host.messaging.publication.publishMessage(ctx.topicId, message);
    } catch (error) {
      pendingRequests.delete(message.id);
      try {
        host.durability.gates.quarantine(prepared.gate.gateId, ownerId, now());
      } catch {
        // A retry can recover the owner-local gate after the storage fault clears.
      }
      return errorResult(
        `Error: failed to publish request_vault_secret: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return answerToolResult(key, (await promise).outcome);
  }

  function createToolDefinition(ctx: RequestVaultToolContext): SharedMcpTool {
    return {
      name: "request_vault_secret",
      description:
        "Ask the user to store a secret value in their Vault. You choose the key name and a short description of what to paste; the user types only the value on a surface that can mask it, and you never see the raw value. Use this instead of asking the user to paste a secret directly into chat. After it succeeds, reference the value as {{KEY}} in supported transient tool inputs. Fails if the key already exists unless you pass overwrite: true.",
      schema: {
        key: z
          .string()
          .describe(
            "Vault key name, e.g. STRIPE_API_KEY. Letters/digits/underscores, must start with a letter.",
          ),
        description: z
          .string()
          .max(MAX_DESCRIPTION_CHARS)
          .describe("One sentence telling the user what value to paste and where it's from."),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            "Set true to replace the value of a key that already exists. Defaults to false, which fails instead of silently clobbering an existing secret.",
          ),
        idempotency_key: z
          .string()
          .max(MAX_IDEMPOTENCY_KEY_CHARS)
          .optional()
          .describe(
            "Optional retry key. Reusing it with the same key/description replays the existing result; reusing it with different content fails.",
          ),
      },
      async handler(input) {
        return requestVaultSecret(ctx, input);
      },
    };
  }

  async function deleteVaultSecret(ctx: RequestVaultToolContext, input: { key?: unknown }) {
    const topic = host.topics.getTopic(ctx.topicId);
    if (!topic) return errorResult(`Error: topic '${ctx.topicId}' not found.`);
    if (!topic.participants.some((participant) => participant.userId === ctx.userId)) {
      return errorResult("Error: user is not a member of this topic.");
    }
    if (typeof input.key !== "string" || !input.key.trim()) {
      return errorResult("Error: key is required.");
    }
    const key = normalizeVaultKey(input.key);
    if (!VAULT_KEY_PATTERN.test(key)) {
      return errorResult(
        "Error: key must start with a letter and contain only uppercase letters, digits, and underscores (max 128 chars).",
      );
    }
    let deleted: boolean;
    try {
      deleted = host.vault.del(ctx.userId, key);
    } catch (error) {
      return errorResult(
        `Error: failed to delete vault key '${key}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!deleted) {
      return errorResult(`Error: vault key '${key}' does not exist.`);
    }
    return textResult(`Deleted vault key ${key}.`);
  }

  function createDeleteToolDefinition(ctx: RequestVaultToolContext): SharedMcpTool {
    return {
      name: "delete_vault_secret",
      description:
        "Permanently delete a key from the user's Vault. This removes the stored value outright — there is no confirmation step and no undo. Use request_vault_secret with overwrite: true instead if the goal is just to replace a value.",
      schema: {
        key: z.string().describe("Vault key name to delete, e.g. STRIPE_API_KEY."),
      },
      async handler(input) {
        return deleteVaultSecret(ctx, input);
      },
    };
  }

  return {
    startGateOwner,
    stopGateOwner,
    reconcilePendingGates,
    answerPendingRequest,
    cancelPendingRequests,
    createToolDefinition,
    createDeleteToolDefinition,
  };
}

export const defaultRequestVaultDurabilityHost: RequestVaultRuntimeHost["durability"] = {
  gates: {
    prepare: prepareVaultRequestGate,
    claimAndAnswer: claimVaultRequestGateAndAnswer,
    cancel: cancelVaultRequestGate,
    quarantine: quarantineVaultRequestGate,
    quarantineForeign: quarantineForeignVaultRequestGates,
  },
  processLeases: {
    acquire: (role, ownerId) => acquireRuntimeProcessLease(role, { ownerId }),
    list: listRuntimeProcessLeases,
    isAlive: isRuntimeProcessLeaseAlive,
    removeDead: removeDeadRuntimeProcessLeases,
  },
};

const defaultRequestVaultRuntime = createRequestVaultRuntime({
  messaging: {
    persistence: {
      getMessage: getApiMessage,
      appendMessage: appendApiMessage,
    },
    publication: {
      publishMessage: (topicId, message) => WsHub.get().broadcastMessage(topicId, message),
      publishCardUpdate: (update) =>
        WsHub.get().broadcastMessageUpdated(update.topicId, update.messageId, {
          vaultSecretRequest: update.vaultSecretRequest,
          editedAt: update.editedAt,
        }),
    },
  },
  topics: {
    getTopic,
    getConfig: getApiTopicConfig,
  },
  vault: {
    hasKey: vaultHasKey,
    set: vaultSet,
    del: vaultDel,
  },
  durability: defaultRequestVaultDurabilityHost,
  runtime: {
    ownerId: VAULT_GATE_OWNER_ID,
    createId: randomUUID,
    now: () => new Date().toISOString(),
  },
});

export function startRequestVaultGateOwner(): void {
  defaultRequestVaultRuntime.startGateOwner();
}

export function stopRequestVaultGateOwner(): void {
  defaultRequestVaultRuntime.stopGateOwner();
}

export function reconcilePendingRequestVaultGates(): number {
  return defaultRequestVaultRuntime.reconcilePendingGates();
}

/**
 * Host-neutral answer path for pending vault-request cards. Terminal and
 * Otium should call this rather than reimplementing pending-map and
 * persistence ordering. `value: null` means the user declined; any other
 * string is the secret, stored via `vaultSet` before the gate is claimed,
 * and never echoed back in the result.
 */
export function answerPendingVaultSecretRequest(
  topicId: string,
  messageId: string,
  userId: string,
  value: string | null,
): AnswerVaultSecretRequestResult {
  return defaultRequestVaultRuntime.answerPendingRequest(topicId, messageId, userId, value);
}

export function cancelPendingVaultSecretRequests(topicId: string, queryId: string): void {
  defaultRequestVaultRuntime.cancelPendingRequests(topicId, queryId);
}

export function createRequestVaultToolDefinition(ctx: RequestVaultToolContext): SharedMcpTool {
  return defaultRequestVaultRuntime.createToolDefinition(ctx);
}

export function createDeleteVaultToolDefinition(ctx: RequestVaultToolContext): SharedMcpTool {
  return defaultRequestVaultRuntime.createDeleteToolDefinition(ctx);
}
