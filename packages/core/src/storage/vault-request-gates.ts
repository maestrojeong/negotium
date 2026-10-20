import { db } from "#storage/forum-db";
import { registerStorageSchemaInitializer } from "#storage/storage-host";
import type { VaultSecretRequestDto } from "#types/api";

export type VaultRequestGateState =
  | "pending"
  | "claimed"
  | "answered"
  | "cancelled"
  | "quarantined";

export interface VaultRequestGateRecord {
  gateId: string;
  topicId: string;
  queryId?: string;
  idempotencyKey: string;
  bodyHash: string;
  messageId: string;
  ownerId: string;
  state: VaultRequestGateState;
  outcome?: "fulfilled" | "declined";
  answeredBy?: string;
}

interface VaultRequestGateRow {
  gate_id: string;
  topic_id: string;
  query_id: string | null;
  idempotency_key: string;
  body_hash: string;
  message_id: string;
  owner_id: string;
  state: VaultRequestGateState;
  outcome: "fulfilled" | "declined" | null;
  answered_by: string | null;
}

export interface VaultRequestGateCardUpdate {
  topicId: string;
  messageId: string;
  vaultSecretRequest: VaultSecretRequestDto;
  editedAt: string;
}

function initializeVaultRequestGateSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_request_gates (
      gate_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES api_topics(id) ON DELETE CASCADE,
      query_id TEXT,
      idempotency_key TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      state TEXT NOT NULL,
      outcome TEXT,
      answered_by TEXT,
      claim_source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vault_request_gates_idempotency
      ON vault_request_gates(topic_id, idempotency_key, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_request_gates_active_key
      ON vault_request_gates(topic_id, idempotency_key)
      WHERE state IN ('pending', 'claimed');
  `);
}

registerStorageSchemaInitializer(initializeVaultRequestGateSchema, 32);

function fromRow(row: VaultRequestGateRow): VaultRequestGateRecord {
  return {
    gateId: row.gate_id,
    topicId: row.topic_id,
    queryId: row.query_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    bodyHash: row.body_hash,
    messageId: row.message_id,
    ownerId: row.owner_id,
    state: row.state,
    outcome: row.outcome ?? undefined,
    answeredBy: row.answered_by ?? undefined,
  };
}

function latestGate(topicId: string, idempotencyKey: string): VaultRequestGateRecord | null {
  const row = db
    .query(
      `SELECT * FROM vault_request_gates
       WHERE topic_id = ? AND idempotency_key = ?
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(topicId, idempotencyKey) as VaultRequestGateRow | undefined;
  return row ? fromRow(row) : null;
}

function expireVaultCard(
  topicId: string,
  messageId: string,
  editedAt: string,
): VaultRequestGateCardUpdate | null {
  const row = db
    .query(
      `SELECT vault_secret_request FROM api_messages
       WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'vault_secret_request'`,
    )
    .get(topicId, messageId) as { vault_secret_request: string | null } | undefined;
  if (!row?.vault_secret_request) return null;
  const request = JSON.parse(row.vault_secret_request) as VaultSecretRequestDto;
  if (request.status !== "pending") return null;
  const expired: VaultSecretRequestDto = { ...request, status: "expired" };
  db.query(
    `UPDATE api_messages SET vault_secret_request = ?, edited_at = ?
     WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'vault_secret_request'`,
  ).run(JSON.stringify(expired), editedAt, topicId, messageId);
  return { topicId, messageId, vaultSecretRequest: expired, editedAt };
}

export type PrepareVaultRequestGateResult =
  | { outcome: "created"; gate: VaultRequestGateRecord }
  | { outcome: "pending"; gate: VaultRequestGateRecord }
  | { outcome: "replay"; gate: VaultRequestGateRecord }
  | { outcome: "conflict"; gate: VaultRequestGateRecord };

export function prepareVaultRequestGate(args: {
  gateId: string;
  topicId: string;
  queryId?: string;
  idempotencyKey: string;
  bodyHash: string;
  messageId: string;
  ownerId: string;
  now: string;
}): PrepareVaultRequestGateResult {
  return db
    .transaction(() => {
      const latest = latestGate(args.topicId, args.idempotencyKey);
      if (latest?.bodyHash !== undefined && latest.bodyHash !== args.bodyHash) {
        return { outcome: "conflict", gate: latest } as const;
      }
      if (latest?.state === "answered") return { outcome: "replay", gate: latest } as const;
      if (latest && (latest.state === "pending" || latest.state === "claimed")) {
        return { outcome: "pending", gate: latest } as const;
      }

      db.query(
        `INSERT INTO vault_request_gates
       (gate_id, topic_id, query_id, idempotency_key, body_hash, message_id, owner_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        args.gateId,
        args.topicId,
        args.queryId ?? null,
        args.idempotencyKey,
        args.bodyHash,
        args.messageId,
        args.ownerId,
        args.now,
        args.now,
      );
      return {
        outcome: "created",
        gate: {
          gateId: args.gateId,
          topicId: args.topicId,
          queryId: args.queryId,
          idempotencyKey: args.idempotencyKey,
          bodyHash: args.bodyHash,
          messageId: args.messageId,
          ownerId: args.ownerId,
          state: "pending",
        },
      } as const;
    })
    .immediate();
}

export function quarantineVaultRequestGate(
  gateId: string,
  ownerId: string,
  now = new Date().toISOString(),
): VaultRequestGateCardUpdate | null {
  return db
    .transaction(() => {
      const row = db.query("SELECT * FROM vault_request_gates WHERE gate_id = ?").get(gateId) as
        | VaultRequestGateRow
        | undefined;
      if (!row || row.owner_id !== ownerId || !["pending", "claimed"].includes(row.state)) {
        return null;
      }
      const result = db
        .query(
          `UPDATE vault_request_gates SET state = 'quarantined', updated_at = ?
         WHERE gate_id = ? AND owner_id = ? AND state IN ('pending', 'claimed')`,
        )
        .run(now, gateId, ownerId);
      if (Number(result.changes ?? 0) === 0) return null;
      return expireVaultCard(row.topic_id, row.message_id, now);
    })
    .immediate();
}

export function quarantineForeignVaultRequestGates(
  liveOwnerIds: ReadonlySet<string>,
  now = new Date().toISOString(),
): VaultRequestGateCardUpdate[] {
  return db
    .transaction(() => {
      const rows = db
        .query(
          `SELECT * FROM vault_request_gates
         WHERE state IN ('pending', 'claimed')`,
        )
        .all() as VaultRequestGateRow[];
      const updates: VaultRequestGateCardUpdate[] = [];
      for (const row of rows) {
        if (liveOwnerIds.has(row.owner_id)) continue;
        if (row.state === "claimed" && row.outcome && row.answered_by) {
          db.query(
            `UPDATE vault_request_gates SET state = 'answered', updated_at = ?
           WHERE gate_id = ? AND state = 'claimed'`,
          ).run(now, row.gate_id);
          continue;
        }
        const result = db
          .query(
            `UPDATE vault_request_gates SET state = 'quarantined', updated_at = ?
           WHERE gate_id = ? AND state IN ('pending', 'claimed')`,
          )
          .run(now, row.gate_id);
        if (Number(result.changes ?? 0) === 0) continue;
        const update = expireVaultCard(row.topic_id, row.message_id, now);
        if (update) updates.push(update);
      }
      const legacyCards = db
        .query(
          `SELECT m.topic_id, m.id
         FROM api_messages m
         LEFT JOIN vault_request_gates g ON g.message_id = m.id
         WHERE m.kind = 'vault_secret_request'
           AND m.deleted = 0
           AND g.gate_id IS NULL`,
        )
        .all() as { topic_id: string; id: string }[];
      for (const card of legacyCards) {
        const update = expireVaultCard(card.topic_id, card.id, now);
        if (update) updates.push(update);
      }
      return updates;
    })
    .immediate();
}

export type ClaimVaultRequestGateResult =
  | {
      outcome: "claimed";
      gate: VaultRequestGateRecord;
      vaultSecretRequest: VaultSecretRequestDto;
      editedAt: string;
    }
  | { outcome: "unavailable" };

/**
 * Claim the gate and mark the card's outcome. This never touches the secret
 * value itself — the caller is responsible for writing to the vault (via
 * `vaultSet`) *before* calling this, so the card only ever reflects
 * "fulfilled"/"declined", never the plaintext.
 */
export function claimVaultRequestGateAndAnswer(args: {
  topicId: string;
  messageId: string;
  outcome: "fulfilled" | "declined";
  userId: string;
  ownerId: string;
  source: string;
  now: string;
}): ClaimVaultRequestGateResult {
  return db
    .transaction(() => {
      const row = db
        .query(
          `SELECT * FROM vault_request_gates
         WHERE topic_id = ? AND message_id = ?
         ORDER BY rowid DESC LIMIT 1`,
        )
        .get(args.topicId, args.messageId) as VaultRequestGateRow | undefined;
      if (!row || row.owner_id !== args.ownerId || row.state !== "pending") {
        return { outcome: "unavailable" } as const;
      }
      const message = db
        .query(
          `SELECT vault_secret_request FROM api_messages
         WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'vault_secret_request'`,
        )
        .get(args.topicId, args.messageId) as { vault_secret_request: string | null } | undefined;
      if (!message?.vault_secret_request) return { outcome: "unavailable" } as const;
      const request = JSON.parse(message.vault_secret_request) as VaultSecretRequestDto;
      if (request.status !== "pending") return { outcome: "unavailable" } as const;

      const claimed = db
        .query(
          `UPDATE vault_request_gates
         SET state = 'answered', outcome = ?, answered_by = ?, claim_source = ?, updated_at = ?
         WHERE gate_id = ? AND owner_id = ? AND state = 'pending'`,
        )
        .run(args.outcome, args.userId, args.source, args.now, row.gate_id, args.ownerId);
      if (Number(claimed.changes ?? 0) === 0) return { outcome: "unavailable" } as const;

      const answered: VaultSecretRequestDto = {
        ...request,
        status: args.outcome,
        answeredBy: args.userId,
      };
      db.query(
        `UPDATE api_messages SET vault_secret_request = ?, edited_at = ?
       WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'vault_secret_request'`,
      ).run(JSON.stringify(answered), args.now, args.topicId, args.messageId);
      return {
        outcome: "claimed",
        gate: fromRow({
          ...row,
          state: "answered",
          outcome: args.outcome,
          answered_by: args.userId,
        }),
        vaultSecretRequest: answered,
        editedAt: args.now,
      } as const;
    })
    .immediate();
}

export function cancelVaultRequestGate(
  topicId: string,
  messageId: string,
  ownerId: string,
  now = new Date().toISOString(),
): VaultRequestGateCardUpdate | null {
  return db
    .transaction(() => {
      const row = db
        .query(
          `SELECT * FROM vault_request_gates
         WHERE topic_id = ? AND message_id = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(topicId, messageId) as VaultRequestGateRow | undefined;
      if (!row || row.owner_id !== ownerId || row.state !== "pending") return null;
      const result = db
        .query(
          `UPDATE vault_request_gates SET state = 'cancelled', updated_at = ?
         WHERE gate_id = ? AND owner_id = ? AND state = 'pending'`,
        )
        .run(now, row.gate_id, ownerId);
      if (Number(result.changes ?? 0) === 0) return null;
      return expireVaultCard(topicId, messageId, now);
    })
    .immediate();
}
