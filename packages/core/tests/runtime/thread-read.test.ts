import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { renderThreadForModel, renderTopicThreadList } from "#runtime/thread-read";
import {
  appendApiMessage,
  findThreadRootsByPrefix,
  listTopicThreadRoots,
} from "#storage/api-messages";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import type { MessageDto } from "#types/api";

const topics: string[] = [];

afterEach(() => {
  for (const topicId of topics.splice(0)) {
    db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topicId);
    deleteTopic(topicId);
  }
});

function newTopic(): string {
  const topicId = randomUUID();
  const now = new Date().toISOString();
  upsertTopic({
    id: topicId,
    title: `thread-read ${topicId.slice(0, 8)}`,
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMention: false,
    participants: [{ userId: "local", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  topics.push(topicId);
  return topicId;
}

let clock = 0;
function say(topicId: string, authorId: string, text: string, threadRootId?: string): MessageDto {
  clock += 1;
  const message: MessageDto = {
    id: randomUUID(),
    topicId,
    authorId,
    text,
    ...(threadRootId ? { threadRootId } : {}),
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, clock)).toISOString(),
  };
  appendApiMessage(message, { notify: false });
  return message;
}

test("renders a thread's own conversation, root first, without channel noise", () => {
  const topicId = newTopic();
  const root = say(topicId, "ai", "검증 전수 완료. 결과가 명확합니다.");
  say(topicId, "user-a", "채널에서 한 딴 얘기");
  say(topicId, "user-a", "스코프별로 갈라서 보여줘", root.id);
  say(topicId, "ai", "local 12, otium 4, worker 2 입니다.", root.id);

  const rendered = renderThreadForModel(topicId, root.id);
  expect(rendered).toContain("2 replies");
  expect(rendered).toContain("검증 전수 완료");
  expect(rendered).toContain("스코프별로 갈라서 보여줘");
  expect(rendered).toContain("local 12, otium 4, worker 2");
  expect(rendered).not.toContain("채널에서 한 딴 얘기");

  // Chronological, and the root leads.
  const lines = rendered!.split("\n").filter((line) => line.startsWith("["));
  expect(lines[1]).toContain("검증 전수 완료");
  expect(lines[2]).toContain("스코프별로");
  expect(lines[3]).toContain("local 12");
});

test("marks replies as belonging to the thread so a flat read stays groupable", () => {
  const topicId = newTopic();
  const root = say(topicId, "ai", "루트");
  say(topicId, "user-a", "답장", root.id);

  const rendered = renderThreadForModel(topicId, root.id);
  expect(rendered).toContain("(in thread #");
});

test("keeps the recent end and reports what it dropped", () => {
  const topicId = newTopic();
  const root = say(topicId, "ai", "루트");
  for (let index = 1; index <= 5; index += 1) say(topicId, "user-a", `답장 ${index}`, root.id);

  const rendered = renderThreadForModel(topicId, root.id, 2);
  expect(rendered).toContain("5 replies");
  expect(rendered).toContain("[3 earlier replies omitted.]");
  expect(rendered).toContain("답장 4");
  expect(rendered).toContain("답장 5");
  expect(rendered).not.toContain("답장 1");
});

test("returns null for a root that is not in this room", () => {
  const topicId = newTopic();
  expect(renderThreadForModel(topicId, randomUUID())).toBeNull();
});

test("a deleted root does not hide the thread, but is not quoted either", () => {
  const topicId = newTopic();
  const root = say(topicId, "ai", "지워진 루트");
  say(topicId, "user-a", "살아있는 답장", root.id);
  db.query("UPDATE api_messages SET deleted = 1 WHERE id = ?").run(root.id);

  const rendered = renderThreadForModel(topicId, root.id);
  expect(rendered).toContain("살아있는 답장");
  expect(rendered).not.toContain("지워진 루트");
});

test("lists this room's threads by recent activity with a readable root", () => {
  const topicId = newTopic();
  const older = say(topicId, "ai", "배포 스크립트 권한 문제");
  say(topicId, "user-a", "1", older.id);
  const newer = say(topicId, "ai", "검증 전수 완료. 결과가 명확합니다.");
  say(topicId, "user-a", "2", newer.id);
  say(topicId, "user-a", "3", newer.id);

  const roots = listTopicThreadRoots(topicId);
  expect(roots.map((entry) => entry.rootId)).toEqual([newer.id, older.id]);
  expect(roots[0].replyCount).toBe(2);

  const rendered = renderTopicThreadList(topicId);
  expect(rendered).toContain("검증 전수 완료");
  expect(rendered).toContain("배포 스크립트 권한 문제");
  expect(rendered).toContain("2 replies");
  expect(rendered).toContain("1 reply");
  expect(rendered.indexOf("검증 전수")).toBeLessThan(rendered.indexOf("배포 스크립트"));
});

test("says so plainly when a room has no threads", () => {
  const topicId = newTopic();
  say(topicId, "user-a", "채널 메시지");
  expect(renderTopicThreadList(topicId)).toBe("No threads in this room yet.");
});

test("resolves a short tag by prefix regardless of how old the thread is", () => {
  const topicId = newTopic();
  const target = say(topicId, "ai", "오래된 루트", undefined);
  db.query("UPDATE api_messages SET id = ? WHERE id = ?").run("000000aa-old", target.id);
  say(topicId, "user-a", "오래된 답장", "000000aa-old");
  // 201 newer threads: a resolver capped at the most recent N would report the
  // older thread as nonexistent, which is the one a stale tag names.
  for (let index = 0; index < 201; index += 1) {
    const root = say(topicId, "ai", `루트 ${index}`);
    say(topicId, "user-a", `답장 ${index}`, root.id);
  }

  expect(findThreadRootsByPrefix(topicId, "#000000")).toEqual(["000000aa-old"]);
  expect(renderThreadForModel(topicId, "000000aa-old")).toContain("오래된 답장");
});

test("reports a colliding tag instead of picking a thread", () => {
  const topicId = newTopic();
  for (const id of ["abcdef11-one", "abcdef22-two"]) {
    const root = say(topicId, "ai", `루트 ${id}`);
    db.query("UPDATE api_messages SET id = ? WHERE id = ?").run(id, root.id);
    say(topicId, "user-a", `답장 ${id}`, id);
  }

  // Six hex characters is 24 bits; the caller has to be told, not guessed for.
  expect(findThreadRootsByPrefix(topicId, "#abcdef").sort()).toEqual([
    "abcdef11-one",
    "abcdef22-two",
  ]);
  // A full id stays unambiguous.
  expect(findThreadRootsByPrefix(topicId, "abcdef11-one")).toEqual(["abcdef11-one"]);
});

test("names a thread whose root was deleted instead of listing it blank", () => {
  const topicId = newTopic();
  const root = say(topicId, "ai", "지워질 루트");
  say(topicId, "user-a", "답장", root.id);
  // Soft deletion as the delete route performs it: the text is cleared too.
  db.query("UPDATE api_messages SET deleted = 1, text = '' WHERE id = ?").run(root.id);

  const rendered = renderTopicThreadList(topicId);
  expect(rendered).toContain("(root message deleted)");
  expect(rendered).toContain("1 reply");
});
