/**
 * Reading a thread back out of the canonical store, on demand.
 *
 * The prompt renderer names a thread rather than restating it (see
 * `thread-context.ts`), which is right while the session still holds the
 * earlier replies. It stops being enough after `/compact` or a session reset:
 * the tag survives in the visible transcript but the text behind it is gone.
 *
 * Pulling the thread with a tool — instead of prepending it to every turn —
 * spends tokens only in the case that actually needs them.
 */

import { formatChannelTranscriptLine } from "#runtime/channel-context";
import { elideMiddle, threadTag } from "#runtime/thread-context";
import {
  countThreadReplies,
  listThreadMessageRows,
  listTopicThreadRoots,
} from "#storage/api-messages";

/** Replies returned by one `thread_read` unless the caller asks for fewer. */
export const THREAD_READ_DEFAULT_LIMIT = 50;
export const THREAD_READ_MAX_LIMIT = 200;

export function renderThreadForModel(
  topicId: string,
  rootId: string,
  limit = THREAD_READ_DEFAULT_LIMIT,
): string | null {
  const capped = Math.min(Math.max(1, limit), THREAD_READ_MAX_LIMIT);
  const { root, replies } = listThreadMessageRows(topicId, rootId, capped);
  if (!root) return null;
  const total = countThreadReplies(topicId, rootId);
  const omitted = Math.max(0, total - replies.length);
  const lines = [root, ...replies]
    .filter((row) => !row.deleted)
    .map((row) => formatChannelTranscriptLine(row));
  return [
    `[Thread ${threadTag(rootId)}] ${total} ${total === 1 ? "reply" : "replies"}, chronological.`,
    omitted > 0 ? `[${omitted} earlier repl${omitted === 1 ? "y" : "ies"} omitted.]` : undefined,
    "",
    ...lines,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function renderTopicThreadList(topicId: string, limit = 20): string {
  const roots = listTopicThreadRoots(topicId, limit);
  if (roots.length === 0) return "No threads in this room yet.";
  const rows = roots.map((entry) => {
    const { root } = listThreadMessageRows(topicId, entry.rootId, 1);
    // A soft delete clears the row's text, so `root` being present is not the
    // same as it having a title. Without the explicit check the thread lists
    // with an empty subject and cannot be recognised.
    const title =
      root && !root.deleted ? elideMiddle(root.text, 120) || "(no text)" : "(root message deleted)";
    const count = `${entry.replyCount} ${entry.replyCount === 1 ? "reply" : "replies"}`;
    return `${threadTag(entry.rootId)}  ${count}  last ${entry.lastReplyAt}  ${title}`;
  });
  return [
    "Threads in this room, most recently active first.",
    "Read one in full with thread_read.",
    "",
    ...rows,
  ].join("\n");
}
