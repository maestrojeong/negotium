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

export function loadTerminalInputHistory(userId: string, limit = 200): string[] {
  const safeLimit = Math.max(1, Math.min(limit, MAX_STORED_HISTORY));
  return db
    .query<HistoryRow, [string, number]>(
      `SELECT text FROM (
         SELECT seq, text
         FROM terminal_input_history
         WHERE user_id = ?
         ORDER BY seq DESC
         LIMIT ?
       ) ORDER BY seq ASC`,
    )
    .all(userId, safeLimit)
    .map((row) => row.text);
}

export function appendTerminalInputHistory(userId: string, value: string): void {
  const text = value.trim();
  if (!text) return;
  db.transaction(() => {
    const latest = db
      .query<HistoryRow, [string]>(
        "SELECT text FROM terminal_input_history WHERE user_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(userId);
    if (latest?.text === text) return;
    db.query("INSERT INTO terminal_input_history (user_id, text, created_at) VALUES (?, ?, ?)").run(
      userId,
      text,
      Date.now(),
    );
    db.query(
      `DELETE FROM terminal_input_history
       WHERE user_id = ? AND seq NOT IN (
         SELECT seq FROM terminal_input_history
         WHERE user_id = ? ORDER BY seq DESC LIMIT ?
       )`,
    ).run(userId, userId, MAX_STORED_HISTORY);
  }).immediate();
}
