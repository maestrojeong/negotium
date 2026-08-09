import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { GENERAL_TOPIC_ID } from "#platform/constants";
import {
  deleteTopic,
  findTopicTitleConflict,
  getTopic,
  getTopicByNameForUser,
  getTopicMemoryOrigin,
  getTopicSessionId,
  grantSubagentTellTarget,
  listTopics,
  normalizeTopicState,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
import { db } from "#storage/forum-db";
import { getVisibleTopics } from "#topics/derive";
import type { TopicDto } from "#types/api";

const createdTopicIds: string[] = [];

function makeTopic(id = `topic-${randomUUID()}`): TopicDto {
  const now = new Date().toISOString();
  return {
    id,
    title: `Topic ${randomUUID().slice(0, 8)}`,
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMention: false,
    participants: [{ userId: "owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  };
}

afterEach(() => {
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
});

describe("api topic storage", () => {
  test("uses the canonical topic and membership schema", () => {
    const topicColumns = (
      db.query("PRAGMA table_info(api_topics)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    const memberColumns = (
      db.query("PRAGMA table_info(topic_members)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    const topicIndexes = (
      db.query("PRAGMA index_list(api_topics)").all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(topicColumns).toContain("agent");
    expect(topicColumns).toContain("response_policy");
    expect(topicColumns).toContain("base_model");
    expect(topicColumns).toContain("visibility");
    expect(topicColumns).toContain("surface");
    // Retired by the surface migration: a room reaches Otium by living there.
    expect(topicColumns).not.toContain("access_mode");
    expect(topicColumns).toContain("subagent_report_mode");
    expect(topicColumns).toContain("memory_topic_id");
    expect(topicColumns).toContain("memory_key");
    expect(topicColumns).not.toContain("runtime_agent");
    expect(topicColumns).not.toContain("participants");
    expect(topicColumns).not.toContain("ai_mention");
    expect(topicColumns).not.toContain("is_archived");
    expect(topicIndexes).toContain("idx_api_topics_last_message");
    expect(memberColumns).toEqual(["topic_id", "user_id", "role"]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("upsertTopic preserves the durable AI session id on metadata updates", () => {
    const topic = makeTopic();
    createdTopicIds.push(topic.id);
    upsertTopic(topic);
    setTopicSessionId(topic.id, "session-1");

    upsertTopic({
      ...topic,
      title: "Renamed topic",
      description: "metadata-only update",
      lastMessageAt: new Date().toISOString(),
    });

    expect(getTopicSessionId(topic.id)).toBe("session-1");
  });

  test("listTopics hydrates participants for every topic", () => {
    const first = makeTopic();
    const second = makeTopic();
    first.participants.push({ userId: "member-1", role: "member" });
    second.participants.push({ userId: "member-2", role: "member" });
    createdTopicIds.push(first.id, second.id);
    upsertTopic(first);
    upsertTopic(second);

    const listed = new Map(listTopics().map((topic) => [topic.id, topic]));

    expect(listed.get(first.id)?.participants).toEqual(first.participants);
    expect(listed.get(second.id)?.participants).toEqual(second.participants);
  });

  test("hydrates explicit tell targets for subagent topics", () => {
    const parent = makeTopic();
    const child = {
      ...makeTopic(),
      isSubagent: true,
      parentTopicId: parent.id,
    };
    const target = makeTopic();
    createdTopicIds.push(parent.id, child.id, target.id);
    upsertTopic(parent);
    upsertTopic(child);
    upsertTopic(target);
    grantSubagentTellTarget(child.id, target.id, parent.id);

    expect(getTopic(child.id)?.subagentTellTargetIds).toEqual([target.id]);
    expect(getTopic(parent.id)?.subagentTellTargetIds).toBeUndefined();
  });

  test("persists a subagent report mode for graph and authorization clients", () => {
    const parent = makeTopic();
    const child = {
      ...makeTopic(),
      isSubagent: true,
      parentTopicId: parent.id,
      subagentReportMode: "status-only" as const,
    };
    createdTopicIds.push(parent.id, child.id);
    upsertTopic(parent);
    upsertTopic(child);

    expect(getTopic(child.id)?.subagentReportMode).toBe("status-only");
  });

  test("persists an explicit memory topic and resolves it ahead of the parent chain", () => {
    const parent = makeTopic();
    const memorySource = makeTopic();
    const child = {
      ...makeTopic(),
      isSubagent: true,
      parentTopicId: parent.id,
      memoryTopicId: memorySource.id,
    };
    createdTopicIds.push(parent.id, memorySource.id, child.id);
    upsertTopic(parent);
    upsertTopic(memorySource);
    upsertTopic(child);

    expect(getTopic(child.id)?.memoryTopicId).toBe(memorySource.id);
    expect(getTopicMemoryOrigin(child.id)?.id).toBe(memorySource.id);
  });

  test("persists a canonical title-keyed memory namespace", () => {
    const topic = makeTopic("memory-key");
    createdTopicIds.push(topic.id);
    topic.memoryKey = "persona";
    upsertTopic(topic);

    expect(getTopic(topic.id)?.memoryKey).toBe("persona");
  });

  test("persists explicit topic visibility while defaulting ordinary topics to visible", () => {
    const visible = makeTopic();
    const hidden = { ...makeTopic(), visibility: "hidden" as const };
    createdTopicIds.push(visible.id, hidden.id);
    upsertTopic(visible);
    upsertTopic(hidden);

    expect(getTopic(visible.id)?.visibility).toBe("visible");
    expect(getTopic(hidden.id)?.visibility).toBe("hidden");
    expect(getVisibleTopics().some((topic) => topic.id === visible.id)).toBe(true);
    expect(getVisibleTopics().some((topic) => topic.id === hidden.id)).toBe(false);
  });

  test("defaults topics to the terminal surface and persists an explicit one", () => {
    const local = makeTopic();
    const hub = { ...makeTopic(), surface: "otium" as const };
    createdTopicIds.push(local.id, hub.id);
    upsertTopic(local);
    upsertTopic(hub);

    expect(getTopic(local.id)?.surface).toBe("terminal");
    expect(getTopic(hub.id)?.surface).toBe("otium");
  });

  test("lists only the requested surface", () => {
    const local = makeTopic();
    const hub = { ...makeTopic(), surface: "otium" as const };
    createdTopicIds.push(local.id, hub.id);
    upsertTopic(local);
    upsertTopic(hub);

    const terminalIds = listTopics({ surface: "terminal" }).map((topic) => topic.id);
    const otiumIds = listTopics({ surface: "otium" }).map((topic) => topic.id);
    expect(terminalIds).toContain(local.id);
    expect(terminalIds).not.toContain(hub.id);
    expect(otiumIds).toContain(hub.id);
    expect(otiumIds).not.toContain(local.id);
  });

  /**
   * `getTopicByNameForUser` filters on surface only when asked: its SQL reads
   * `(? IS NULL OR t.surface = ?)`. S-6 claims a missed call site "cannot leak
   * a topic across surfaces", but that only holds if every caller opts in —
   * and several did not, which is how a Telegram `/load` and, worse, `/del`
   * reached a `terminal` topic by name.
   *
   * What is pinned here is the SAFE half: supplying a surface confines the
   * lookup. The unsafe half — that omitting it matches every surface — is
   * deliberately NOT asserted. It is a hazard this code still carries, not a
   * contract; asserting it would make the fail-closed fix that should
   * eventually land (require an explicit surface, or an explicit
   * cross-surface mode, and keep an operator-only helper for the CLI) look
   * like a regression. Documented instead of tested, on purpose.
   */
  test("supplying a surface confines a name lookup to it", () => {
    const title = `Only-Terminal ${randomUUID().slice(0, 8)}`;
    const terminal = { ...makeTopic(), title };
    createdTopicIds.push(terminal.id);
    upsertTopic(terminal);

    expect(getTopicByNameForUser(title, "owner", { surface: "terminal" })?.id).toBe(terminal.id);
    // The scoped call is what stops a telegram caller reaching a terminal room.
    expect(getTopicByNameForUser(title, "owner", { surface: "telegram" })).toBeNull();
    expect(getTopicByNameForUser(title, "owner", { surface: "otium" })).toBeNull();
  });

  test("a name used on two surfaces resolves per surface", () => {
    // Names are unique per surface (S-3), so the same title on two surfaces is
    // legal. Scoping is not only a block: the helper answers on a single match
    // only, so without a surface two rows resolve to nothing and a caller
    // cannot reach even its OWN room once another surface reuses the name.
    const title = `Shared ${randomUUID().slice(0, 8)}`;
    const terminal = { ...makeTopic(), title };
    const telegram = { ...makeTopic(), title, surface: "telegram" as const };
    createdTopicIds.push(terminal.id, telegram.id);
    upsertTopic(terminal);
    upsertTopic(telegram);

    expect(getTopicByNameForUser(title, "owner", { surface: "terminal" })?.id).toBe(terminal.id);
    expect(getTopicByNameForUser(title, "owner", { surface: "telegram" })?.id).toBe(telegram.id);
    expect(getTopicByNameForUser(title, "owner", { surface: "otium" })).toBeNull();
    // Two rows match, and the helper answers only on one, so the deliberate
    // cross-surface scope resolves to nothing rather than picking a side.
    expect(getTopicByNameForUser(title, "owner", { scope: "all" })).toBeNull();
  });

  /**
   * `{ scope: "all" }` is the explicit replacement for what used to happen when
   * a caller simply forgot the surface. It stays available because operator
   * tooling — the CLI managing cron jobs across surfaces — genuinely wants it;
   * the difference is that it now reads as a decision at the call site.
   */
  test("scope 'all' reaches a topic on any surface", () => {
    const title = `Anywhere ${randomUUID().slice(0, 8)}`;
    const telegram = { ...makeTopic(), title, surface: "telegram" as const };
    createdTopicIds.push(telegram.id);
    upsertTopic(telegram);

    expect(getTopicByNameForUser(title, "owner", { scope: "all" })?.id).toBe(telegram.id);
    expect(getTopicByNameForUser(title, "owner", { surface: "terminal" })).toBeNull();
    // Participation still gates it — a wider surface scope is not wider access.
    expect(getTopicByNameForUser(title, "someone-else", { scope: "all" })).toBeNull();
  });

  test("an upsert without a surface lands on the host default, not on terminal", () => {
    // Embedding hosts (Otium) build topic literals by hand and never name a
    // surface; the host declares one in its environment instead.
    const previous = process.env.NEGOTIUM_DEFAULT_SURFACE;
    process.env.NEGOTIUM_DEFAULT_SURFACE = "otium";
    const hosted = makeTopic();
    createdTopicIds.push(hosted.id);
    try {
      upsertTopic(hosted);
      expect(getTopic(hosted.id)?.surface).toBe("otium");
    } finally {
      if (previous === undefined) delete process.env.NEGOTIUM_DEFAULT_SURFACE;
      else process.env.NEGOTIUM_DEFAULT_SURFACE = previous;
    }
  });

  test("manager rooms with the same title are not a conflict — one per user", () => {
    // Every member of a multi-user host gets a personal "General" manager room.
    // Treating those as duplicates renamed real rooms out from under them.
    const title = `General-${randomUUID().slice(0, 8)}`;
    const mine = { ...makeTopic(), title, kind: "manager" as const };
    const theirs = {
      ...makeTopic(),
      title,
      kind: "manager" as const,
      participants: [{ userId: `other-${randomUUID()}`, role: "owner" as const }],
    };
    createdTopicIds.push(mine.id, theirs.id);
    upsertTopic(mine);
    upsertTopic(theirs);

    expect(findTopicTitleConflict(title, "manager")).toBeNull();
    // An agent room by that name is still checked against other agent rooms.
    expect(findTopicTitleConflict(title, "agent")).toBeNull();
  });

  test("the same title may exist once per surface", () => {
    const title = `surface-dup-${randomUUID().slice(0, 8)}`;
    const local = { ...makeTopic(), title };
    const hub = { ...makeTopic(), title, surface: "otium" as const };
    createdTopicIds.push(local.id, hub.id);
    upsertTopic(local);
    upsertTopic(hub);

    expect(findTopicTitleConflict(title, "agent", { surface: "terminal" })?.id).toBe(local.id);
    expect(findTopicTitleConflict(title, "agent", { surface: "otium" })?.id).toBe(hub.id);
    expect(findTopicTitleConflict(title, "agent", { surface: "telegram" })).toBeNull();
  });

  test("the same title may exist once per Otium workspace", () => {
    const title = `scope-dup-${randomUUID().slice(0, 8)}`;
    const alpha = { ...makeTopic(), title, surface: "otium" as const, surfaceScope: "ws_alpha" };
    const beta = { ...makeTopic(), title, surface: "otium" as const, surfaceScope: "ws_beta" };
    createdTopicIds.push(alpha.id, beta.id);
    upsertTopic(alpha);
    upsertTopic(beta);

    const find = (scope: string | null) =>
      findTopicTitleConflict(title, "agent", { surface: "otium", surfaceScope: scope });
    expect(find("ws_alpha")?.id).toBe(alpha.id);
    expect(find("ws_beta")?.id).toBe(beta.id);
    // An unattached node's namespace is its own, not the union of the others'.
    expect(find(null)).toBeNull();
  });

  test("listTopics narrows to one workspace, and null means the unscoped rooms", () => {
    const alpha = { ...makeTopic(), surface: "otium" as const, surfaceScope: "ws_alpha" };
    const beta = { ...makeTopic(), surface: "otium" as const, surfaceScope: "ws_beta" };
    const unscoped = { ...makeTopic(), surface: "otium" as const };
    createdTopicIds.push(alpha.id, beta.id, unscoped.id);
    for (const topic of [alpha, beta, unscoped]) upsertTopic(topic);

    const ids = (scope?: string | null) =>
      listTopics(
        scope === undefined ? { surface: "otium" } : { surface: "otium", surfaceScope: scope },
      ).map((topic) => topic.id);

    expect(ids("ws_alpha")).toContain(alpha.id);
    expect(ids("ws_alpha")).not.toContain(beta.id);
    expect(ids("ws_alpha")).not.toContain(unscoped.id);
    expect(ids(null)).toContain(unscoped.id);
    expect(ids(null)).not.toContain(alpha.id);
    // No scope filter at all still spans the whole surface.
    expect(ids()).toEqual(expect.arrayContaining([alpha.id, beta.id, unscoped.id]));
  });

  test("a room never changes workspace, but an unknown one can be filled in later", () => {
    const topic = { ...makeTopic(), surface: "otium" as const };
    createdTopicIds.push(topic.id);
    upsertTopic(topic);
    expect(getTopic(topic.id)?.surfaceScope).toBeNull();

    upsertTopic({ ...topic, surfaceScope: "ws_alpha" });
    expect(getTopic(topic.id)?.surfaceScope).toBe("ws_alpha");

    // A later write claiming a different workspace must not move the room.
    upsertTopic({ ...topic, surfaceScope: "ws_beta" });
    expect(getTopic(topic.id)?.surfaceScope).toBe("ws_alpha");
  });

  test("only the otium surface carries a workspace", () => {
    const local = { ...makeTopic(), surface: "terminal" as const, surfaceScope: "ws_alpha" };
    createdTopicIds.push(local.id);
    upsertTopic(local);
    expect(getTopic(local.id)?.surfaceScope).toBeNull();
  });

  test("manager rooms stay manager/always while preserving their chosen agent", () => {
    expect(normalizeTopicState({ kind: "manager", agent: "codex", aiMode: "off" })).toEqual({
      kind: "manager",
      aiMode: "always",
      agent: "codex",
    });
  });

  test("deleteTopic refuses to delete General", () => {
    if (!getTopic(GENERAL_TOPIC_ID)) {
      upsertTopic({
        ...makeTopic(GENERAL_TOPIC_ID),
        title: "General",
        agent: "maestro",
      });
    }

    expect(deleteTopic(GENERAL_TOPIC_ID)).toBe(false);
    expect(getTopic(GENERAL_TOPIC_ID)).toMatchObject({
      id: GENERAL_TOPIC_ID,
      kind: "manager",
      aiMode: "always",
      aiMention: false,
      agent: "maestro",
    });
  });

  test("deleteTopic protects UUID-based personal manager rooms", () => {
    const topic = makeTopic();
    topic.kind = "manager";
    topic.agent = "maestro";
    createdTopicIds.push(topic.id);
    upsertTopic(topic);

    expect(deleteTopic(topic.id)).toBe(false);
    expect(getTopic(topic.id)?.kind).toBe("manager");
    expect(deleteTopic(topic.id, { allowManager: true })).toBe(true);
  });
});
