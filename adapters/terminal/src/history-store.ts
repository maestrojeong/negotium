import { db } from "@negotium/core";

const MAX_STORED_HISTORY = 500;

interface HistoryRow {
  text: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS terminal_input_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_terminal_input_history_user_seq ON terminal_input_history(user_id, seq)",
);

// Input history used to be shared across every topic (scoped only by
// user_id), which mixed unrelated conversations' recall together. topic_id
// scopes each entry to the topic it was typed in; rows from before this
// column existed read back as topic_id = '' (a shared "no topic" bucket)
// rather than vanishing.
try {
  db.exec("ALTER TABLE terminal_input_history ADD COLUMN topic_id TEXT NOT NULL DEFAULT ''");
} catch {
  // Column already exists.
}
db.exec(
  "CREATE INDEX IF NOT EXISTS idx_terminal_input_history_user_topic_seq ON terminal_input_history(user_id, topic_id, seq)",
);

export function loadTerminalInputHistory(userId: string, topicId: string, limit = 200): string[] {
  const safeLimit = Math.max(1, Math.min(limit, MAX_STORED_HISTORY));
  return db
    .query<HistoryRow, [string, string, number]>(
      `SELECT text FROM (
         SELECT seq, text
         FROM terminal_input_history
         WHERE user_id = ? AND topic_id = ?
         ORDER BY seq DESC
         LIMIT ?
       ) ORDER BY seq ASC`,
    )
    .all(userId, topicId, safeLimit)
    .map((row) => row.text);
}

export function appendTerminalInputHistory(userId: string, topicId: string, value: string): void {
  const text = value.trim();
  if (!text) return;
  db.transaction(() => {
    const latest = db
      .query<HistoryRow, [string, string]>(
        "SELECT text FROM terminal_input_history WHERE user_id = ? AND topic_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(userId, topicId);
    if (latest?.text === text) return;
    db.query(
      "INSERT INTO terminal_input_history (user_id, topic_id, text, created_at) VALUES (?, ?, ?, ?)",
    ).run(userId, topicId, text, Date.now());
    db.query(
      `DELETE FROM terminal_input_history
       WHERE user_id = ? AND topic_id = ? AND seq NOT IN (
         SELECT seq FROM terminal_input_history
         WHERE user_id = ? AND topic_id = ? ORDER BY seq DESC LIMIT ?
       )`,
    ).run(userId, topicId, userId, topicId, MAX_STORED_HISTORY);
  }).immediate();
}
