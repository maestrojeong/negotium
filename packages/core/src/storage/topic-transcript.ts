export interface TopicArchiveMessageRow {
  id: string;
  topic_id: string;
  parent_id: string | null;
  author_id: string;
  text: string;
  query_id: string | null;
  agent_type: string | null;
  model: string | null;
  attachments: string | null;
  usage: string | null;
  deleted: number;
  created_at: string;
  rowid?: number;
}

export type TopicArchiveRole = "user" | "assistant" | "system";

export interface TopicArchiveTranscriptRecord {
  type: "message";
  index: number;
  topicId: string;
  topicTitle: string;
  id: string;
  createdAt: string;
  rowid?: number;
  role: TopicArchiveRole;
  speaker: string;
  line: string;
  text: string;
  authorId: string;
  parentId?: string;
  queryId?: string;
  agentType?: string;
  model?: string;
  attachments?: unknown;
  usage?: unknown;
  message: TopicArchiveMessageRow;
}

function parseJsonField(value: string | null): unknown | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function transcriptRole(row: TopicArchiveMessageRow): TopicArchiveRole {
  if (row.author_id === "system") return "system";
  if (row.author_id === "ai" || row.agent_type) return "assistant";
  return "user";
}

function transcriptSpeaker(row: TopicArchiveMessageRow, role: TopicArchiveRole): string {
  if (role === "assistant") return row.agent_type ? `assistant:${row.agent_type}` : "assistant";
  if (role === "system") return "system";
  return `user:${row.author_id}`;
}

function oneLine(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 2000 ? `${compact.slice(0, 2000)}...` : compact;
}

export function formatTopicArchiveTranscriptRecord(
  row: TopicArchiveMessageRow,
  topicTitle: string,
  index: number,
): TopicArchiveTranscriptRecord {
  const role = transcriptRole(row);
  const speaker = transcriptSpeaker(row, role);
  const attachments = parseJsonField(row.attachments);
  const usage = parseJsonField(row.usage);

  return {
    type: "message",
    index,
    topicId: row.topic_id,
    topicTitle,
    id: row.id,
    createdAt: row.created_at,
    ...(row.rowid !== undefined ? { rowid: row.rowid } : {}),
    role,
    speaker,
    line: `[${row.created_at}] ${speaker}: ${oneLine(row.text)}`,
    text: row.text,
    authorId: row.author_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    ...(row.query_id ? { queryId: row.query_id } : {}),
    ...(row.agent_type ? { agentType: row.agent_type } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
    ...(usage !== undefined ? { usage } : {}),
    message: row,
  };
}
