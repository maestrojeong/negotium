import { db } from "#storage/forum-db";
import { registerStorageSchemaInitializer } from "#storage/storage-host";
import type { AskUserQuestionDto } from "#types/api";

export type AskUserGateState = "pending" | "claimed" | "answered" | "cancelled" | "quarantined";

export interface AskUserGateRecord {
  gateId: string;
  topicId: string;
  queryId?: string;
  idempotencyKey: string;
  bodyHash: string;
  messageId: string;
  ownerId: string;
  state: AskUserGateState;
  selectedLabel?: string;
  answeredBy?: string;
}

interface AskUserGateRow {
  gate_id: string;
  topic_id: string;
  query_id: string | null;
  idempotency_key: string;
  body_hash: string;
  message_id: string;
  owner_id: string;
  state: AskUserGateState;
  selected_label: string | null;
  answered_by: string | null;
}

export interface AskUserGateCardUpdate {
  topicId: string;
  messageId: string;
  askUserQuestion: AskUserQuestionDto;
  editedAt: string;
}

function initializeAskUserGateSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ask_user_gates (
      gate_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES api_topics(id) ON DELETE CASCADE,
      query_id TEXT,
      idempotency_key TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      state TEXT NOT NULL,
      selected_label TEXT,
      answered_by TEXT,
      claim_source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ask_user_gates_idempotency
      ON ask_user_gates(topic_id, idempotency_key, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ask_user_gates_active_key
      ON ask_user_gates(topic_id, idempotency_key)
      WHERE state IN ('pending', 'claimed');
  `);
}

registerStorageSchemaInitializer(initializeAskUserGateSchema, 31);

function fromRow(row: AskUserGateRow): AskUserGateRecord {
  return {
    gateId: row.gate_id,
    topicId: row.topic_id,
    queryId: row.query_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    bodyHash: row.body_hash,
    messageId: row.message_id,
    ownerId: row.owner_id,
    state: row.state,
    selectedLabel: row.selected_label ?? undefined,
    answeredBy: row.answered_by ?? undefined,
  };
}

function latestGate(topicId: string, idempotencyKey: string): AskUserGateRecord | null {
  const row = db
    .query(
      `SELECT * FROM ask_user_gates
       WHERE topic_id = ? AND idempotency_key = ?
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(topicId, idempotencyKey) as AskUserGateRow | undefined;
  return row ? fromRow(row) : null;
}

function expireAskCard(
  topicId: string,
  messageId: string,
  editedAt: string,
): AskUserGateCardUpdate | null {
  const row = db
    .query(
      `SELECT ask_user_question FROM api_messages
       WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'ask_user_question'`,
    )
    .get(topicId, messageId) as { ask_user_question: string | null } | undefined;
  if (!row?.ask_user_question) return null;
  const ask = JSON.parse(row.ask_user_question) as AskUserQuestionDto;
  if (ask.selectedLabel || ask.expired) return null;
  const expired = { ...ask, expired: true };
  db.query(
    `UPDATE api_messages SET ask_user_question = ?, edited_at = ?
     WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'ask_user_question'`,
  ).run(JSON.stringify(expired), editedAt, topicId, messageId);
  return { topicId, messageId, askUserQuestion: expired, editedAt };
}

export type PrepareAskUserGateResult =
  | { outcome: "created"; gate: AskUserGateRecord }
  | { outcome: "pending"; gate: AskUserGateRecord }
  | { outcome: "replay"; gate: AskUserGateRecord }
  | { outcome: "conflict"; gate: AskUserGateRecord };

export function prepareAskUserGate(args: {
  gateId: string;
  topicId: string;
  queryId?: string;
  idempotencyKey: string;
  bodyHash: string;
  messageId: string;
  ownerId: string;
  now: string;
}): PrepareAskUserGateResult {
  return db
    .transaction(() => {
      const latest = latestGate(args.topicId, args.idempotencyKey);
      if (latest?.bodyHash !== undefined && latest.bodyHash !== args.bodyHash) {
        return { outcome: "conflict", gate: latest } as const;
      }
      if (latest?.state === "answered") return { outcome: "replay", gate: latest } as const;
      if (
        latest &&
        (latest.state === "pending" || latest.state === "claimed") &&
        latest.ownerId === args.ownerId
      ) {
        return { outcome: "pending", gate: latest } as const;
      }
      if (latest && (latest.state === "pending" || latest.state === "claimed")) {
        return { outcome: "pending", gate: latest } as const;
      }

      db.query(
        `INSERT INTO ask_user_gates
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

export function quarantineAskUserGate(
  gateId: string,
  ownerId: string,
  now = new Date().toISOString(),
): AskUserGateCardUpdate | null {
  return db
    .transaction(() => {
      const row = db.query("SELECT * FROM ask_user_gates WHERE gate_id = ?").get(gateId) as
        | AskUserGateRow
        | undefined;
      if (!row || row.owner_id !== ownerId || !["pending", "claimed"].includes(row.state)) {
        return null;
      }
      const result = db
        .query(
          `UPDATE ask_user_gates SET state = 'quarantined', updated_at = ?
         WHERE gate_id = ? AND owner_id = ? AND state IN ('pending', 'claimed')`,
        )
        .run(now, gateId, ownerId);
      if (Number(result.changes ?? 0) === 0) return null;
      return expireAskCard(row.topic_id, row.message_id, now);
    })
    .immediate();
}

export function quarantineForeignAskUserGates(
  liveOwnerIds: ReadonlySet<string>,
  now = new Date().toISOString(),
): AskUserGateCardUpdate[] {
  return db
    .transaction(() => {
      const rows = db
        .query(
          `SELECT * FROM ask_user_gates
         WHERE state IN ('pending', 'claimed')`,
        )
        .all() as AskUserGateRow[];
      const updates: AskUserGateCardUpdate[] = [];
      for (const row of rows) {
        if (liveOwnerIds.has(row.owner_id)) continue;
        if (row.state === "claimed" && row.selected_label && row.answered_by) {
          db.query(
            `UPDATE ask_user_gates SET state = 'answered', updated_at = ?
           WHERE gate_id = ? AND state = 'claimed'`,
          ).run(now, row.gate_id);
          continue;
        }
        const result = db
          .query(
            `UPDATE ask_user_gates SET state = 'quarantined', updated_at = ?
           WHERE gate_id = ? AND state IN ('pending', 'claimed')`,
          )
          .run(now, row.gate_id);
        if (Number(result.changes ?? 0) === 0) continue;
        const update = expireAskCard(row.topic_id, row.message_id, now);
        if (update) updates.push(update);
      }
      const legacyCards = db
        .query(
          `SELECT m.topic_id, m.id
         FROM api_messages m
         LEFT JOIN ask_user_gates g ON g.message_id = m.id
         WHERE m.kind = 'ask_user_question'
           AND m.deleted = 0
           AND g.gate_id IS NULL`,
        )
        .all() as { topic_id: string; id: string }[];
      for (const card of legacyCards) {
        const update = expireAskCard(card.topic_id, card.id, now);
        if (update) updates.push(update);
      }
      return updates;
    })
    .immediate();
}

export type ClaimAskUserGateResult =
  | {
      outcome: "claimed";
      gate: AskUserGateRecord;
      askUserQuestion: AskUserQuestionDto;
      editedAt: string;
    }
  | { outcome: "unavailable" };

export function claimAskUserGateAndSelect(args: {
  topicId: string;
  messageId: string;
  label: string;
  userId: string;
  ownerId: string;
  source: string;
  now: string;
}): ClaimAskUserGateResult {
  return db
    .transaction(() => {
      const row = db
        .query(
          `SELECT * FROM ask_user_gates
         WHERE topic_id = ? AND message_id = ?
         ORDER BY rowid DESC LIMIT 1`,
        )
        .get(args.topicId, args.messageId) as AskUserGateRow | undefined;
      if (!row || row.owner_id !== args.ownerId || row.state !== "pending") {
        return { outcome: "unavailable" } as const;
      }
      const message = db
        .query(
          `SELECT ask_user_question FROM api_messages
         WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'ask_user_question'`,
        )
        .get(args.topicId, args.messageId) as { ask_user_question: string | null } | undefined;
      if (!message?.ask_user_question) return { outcome: "unavailable" } as const;
      const ask = JSON.parse(message.ask_user_question) as AskUserQuestionDto;
      if (
        ask.expired ||
        ask.selectedLabel ||
        !ask.choices.some((choice) => choice.label === args.label)
      ) {
        return { outcome: "unavailable" } as const;
      }

      const claimed = db
        .query(
          `UPDATE ask_user_gates
         SET state = 'answered', selected_label = ?, answered_by = ?, claim_source = ?, updated_at = ?
         WHERE gate_id = ? AND owner_id = ? AND state = 'pending'`,
        )
        .run(args.label, args.userId, args.source, args.now, row.gate_id, args.ownerId);
      if (Number(claimed.changes ?? 0) === 0) return { outcome: "unavailable" } as const;

      const selected = { ...ask, selectedLabel: args.label };
      db.query(
        `UPDATE api_messages SET ask_user_question = ?, edited_at = ?
       WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'ask_user_question'`,
      ).run(JSON.stringify(selected), args.now, args.topicId, args.messageId);
      return {
        outcome: "claimed",
        gate: fromRow({
          ...row,
          state: "answered",
          selected_label: args.label,
          answered_by: args.userId,
        }),
        askUserQuestion: selected,
        editedAt: args.now,
      } as const;
    })
    .immediate();
}

export function cancelAskUserGate(
  topicId: string,
  messageId: string,
  ownerId: string,
  now = new Date().toISOString(),
): AskUserGateCardUpdate | null {
  return db
    .transaction(() => {
      const row = db
        .query(
          `SELECT * FROM ask_user_gates
         WHERE topic_id = ? AND message_id = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(topicId, messageId) as AskUserGateRow | undefined;
      if (!row || row.owner_id !== ownerId || row.state !== "pending") return null;
      const result = db
        .query(
          `UPDATE ask_user_gates SET state = 'cancelled', updated_at = ?
         WHERE gate_id = ? AND owner_id = ? AND state = 'pending'`,
        )
        .run(now, row.gate_id, ownerId);
      if (Number(result.changes ?? 0) === 0) return null;
      return expireAskCard(topicId, messageId, now);
    })
    .immediate();
}
