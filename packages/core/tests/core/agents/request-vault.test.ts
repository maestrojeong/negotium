import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createDeleteVaultToolDefinition,
  createRequestVaultToolDefinition,
} from "#agents/mcp-tools/request-vault";
import { getApiMessage, listApiMessages } from "#storage/api-messages";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { vaultDel, vaultGetValue, vaultSet } from "#storage/vault";
import type { MessageDto } from "#types/api";

const USER = "request-vault-test-user";
const createdTopicIds: string[] = [];
const createdVaultKeys: string[] = [];

function seedTopic(): string {
  const id = `request-vault-${randomUUID()}`;
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `Request Vault ${id}`,
    agent: "maestro",
    defaultModel: "deepseek-pro",
    defaultEffort: "medium",
    participants: [{ userId: USER, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  createdTopicIds.push(id);
  return id;
}

afterEach(() => {
  for (const topicId of createdTopicIds.splice(0)) deleteTopic(topicId);
  for (const key of createdVaultKeys.splice(0)) vaultDel(USER, key);
});

async function waitForVaultCard(topicId: string): Promise<MessageDto> {
  await Bun.sleep(0);
  const found = listApiMessages(topicId).page.find(
    (message) => message.kind === "vault_secret_request",
  );
  if (!found) throw new Error("expected a vault_secret_request card");
  return found;
}

describe("runtime request_vault_secret", () => {
  test("a fulfilled request stores the value and never echoes it to the agent", async () => {
    const topicId = seedTopic();
    const key = `TEST_KEY_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    createdVaultKeys.push(key);

    const tool = createRequestVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-fulfilled",
      agent: "maestro",
    });

    const pending = tool.handler({ key, description: "A test secret" });
    const card = await waitForVaultCard(topicId);
    expect(card.vaultSecretRequest).toEqual({
      key,
      description: "A test secret",
      status: "pending",
    });

    const { answerPendingVaultSecretRequest } = await import("#agents/mcp-tools/request-vault");
    const answered = answerPendingVaultSecretRequest(topicId, card.id, USER, "super-secret-value");
    expect(answered.ok).toBe(true);

    const result = await pending;
    expect(result.isError).not.toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain(`{{${key}}}`);
    expect(text).not.toContain("super-secret-value");
    expect(vaultGetValue(USER, key)).toBe("super-secret-value");
    expect(getApiMessage(topicId, card.id)?.vaultSecretRequest?.status).toBe("fulfilled");

    // The convenience reply next to the card must not carry the secret either.
    const reply = listApiMessages(topicId).page.find((message) => message.parentId === card.id);
    expect(reply?.text).not.toContain("super-secret-value");
  });

  test("a declined request never writes to the vault", async () => {
    const topicId = seedTopic();
    const key = `TEST_DECLINE_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    createdVaultKeys.push(key);

    const tool = createRequestVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-declined",
      agent: "maestro",
    });
    const pending = tool.handler({ key, description: "Never provided" });
    const card = await waitForVaultCard(topicId);

    const { answerPendingVaultSecretRequest } = await import("#agents/mcp-tools/request-vault");
    const answered = answerPendingVaultSecretRequest(topicId, card.id, USER, null);
    expect(answered.ok).toBe(true);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("declined");
    expect(vaultGetValue(USER, key)).toBeUndefined();
  });

  test("refuses to request a key that already exists, without creating a card", async () => {
    const topicId = seedTopic();
    const key = `TEST_EXISTING_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    createdVaultKeys.push(key);
    vaultSet(USER, key, "already-there", "pre-existing");

    const tool = createRequestVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-existing",
      agent: "maestro",
    });
    const result = await tool.handler({ key, description: "Trying to overwrite" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("already exists");
    await Bun.sleep(0);
    expect(
      listApiMessages(topicId).page.some((message) => message.kind === "vault_secret_request"),
    ).toBe(false);
  });

  test("overwrite: true replaces the value of a key that already exists", async () => {
    const topicId = seedTopic();
    const key = `TEST_OVERWRITE_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    createdVaultKeys.push(key);
    vaultSet(USER, key, "old-value", "pre-existing");

    const tool = createRequestVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-overwrite",
      agent: "maestro",
    });
    const pending = tool.handler({ key, description: "Replace it", overwrite: true });
    const card = await waitForVaultCard(topicId);

    const { answerPendingVaultSecretRequest } = await import("#agents/mcp-tools/request-vault");
    expect(answerPendingVaultSecretRequest(topicId, card.id, USER, "new-value").ok).toBe(true);

    const result = await pending;
    expect(result.isError).not.toBe(true);
    expect(vaultGetValue(USER, key)).toBe("new-value");
  });

  test("rejects a malformed key before any card is created", async () => {
    const topicId = seedTopic();
    const tool = createRequestVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-bad-key",
      agent: "maestro",
    });
    const result = await tool.handler({ key: "not valid!", description: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("key must start with a letter");
  });

  test("an unsupported surface (e.g. Telegram) refuses before creating any card", async () => {
    const topicId = seedTopic();
    const tool = createRequestVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-telegram",
      agent: "maestro",
      unsupportedSurface: true,
    });
    const result = await tool.handler({ key: "SOME_KEY", description: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cannot mask secret input safely");
    await Bun.sleep(0);
    expect(
      listApiMessages(topicId).page.some((message) => message.kind === "vault_secret_request"),
    ).toBe(false);
  });

  test("same idempotency key and body replays the fulfilled outcome without a second write", async () => {
    const topicId = seedTopic();
    const key = `TEST_IDEMP_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    createdVaultKeys.push(key);
    const tool = createRequestVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-idempotent",
      agent: "maestro",
    });
    const input = { key, description: "Idempotent secret", idempotency_key: "idem-1" };

    const first = tool.handler(input);
    const card = await waitForVaultCard(topicId);
    const { answerPendingVaultSecretRequest } = await import("#agents/mcp-tools/request-vault");
    expect(answerPendingVaultSecretRequest(topicId, card.id, USER, "value-1").ok).toBe(true);
    await first;

    const replay = await tool.handler(input);
    expect(replay.isError).not.toBe(true);
    expect(replay.content[0]?.text).toContain(`{{${key}}}`);
    expect(vaultGetValue(USER, key)).toBe("value-1");
  });

  test("the turn runner's cancellation path resolves a still-pending card as no_answer", async () => {
    const topicId = seedTopic();
    const key = `TEST_CANCEL_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    createdVaultKeys.push(key);
    const tool = createRequestVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-cancel",
      agent: "maestro",
    });
    const pending = tool.handler({ key, description: "Cancel me" });
    await waitForVaultCard(topicId);

    const { cancelPendingVaultSecretRequests } = await import("#agents/mcp-tools/request-vault");
    cancelPendingVaultSecretRequests(topicId, "query-cancel");

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("turn ended before the user answered");
    expect(vaultGetValue(USER, key)).toBeUndefined();
  });
});

describe("runtime delete_vault_secret", () => {
  test("deletes an existing key", async () => {
    const topicId = seedTopic();
    const key = `TEST_DELETE_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    vaultSet(USER, key, "to-be-deleted", "pre-existing");

    const tool = createDeleteVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-delete",
      agent: "maestro",
    });
    const result = await tool.handler({ key });

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain(`Deleted vault key ${key}`);
    expect(vaultGetValue(USER, key)).toBeUndefined();
  });

  test("errors when the key does not exist", async () => {
    const topicId = seedTopic();
    const key = `TEST_DELETE_MISSING_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

    const tool = createDeleteVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-delete-missing",
      agent: "maestro",
    });
    const result = await tool.handler({ key });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("does not exist");
  });

  test("rejects a malformed key", async () => {
    const topicId = seedTopic();
    const tool = createDeleteVaultToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-delete-bad-key",
      agent: "maestro",
    });
    const result = await tool.handler({ key: "not valid!" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("key must start with a letter");
  });

  test("refuses when the user is not a topic participant", async () => {
    const topicId = seedTopic();
    const key = `TEST_DELETE_AUTH_${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    createdVaultKeys.push(key);
    vaultSet(USER, key, "value", "pre-existing");

    const tool = createDeleteVaultToolDefinition({
      userId: "someone-else",
      topicId,
      queryId: "query-delete-auth",
      agent: "maestro",
    });
    const result = await tool.handler({ key });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not a member of this topic");
    expect(vaultGetValue(USER, key)).toBe("value");
  });
});
