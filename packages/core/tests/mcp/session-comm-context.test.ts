import { describe, expect, test } from "bun:test";
import { parseSessionCommContext } from "#mcp/session-comm/context";

describe("parseSessionCommContext", () => {
  test("parses an explicit standalone context", () => {
    expect(
      parseSessionCommContext(
        [
          "--user-id=user",
          "--topic=Room",
          "--topic-id=id",
          "--subagent-parent-topic-id=parent-id",
          "--peer-host-query-id=query",
          "--depth=2",
          "--reply-only=true",
          "--agent=codex",
        ],
        { userId: "default", agent: "claude" },
      ),
    ).toEqual({
      userId: "user",
      currentTopic: "Room",
      currentTopicId: "id",
      subagentParentTopicId: "parent-id",
      peerHostQueryId: "query",
      depth: 2,
      replyOnly: true,
      agent: "codex",
    });
  });

  test("uses caller defaults and rejects invalid process values", () => {
    expect(parseSessionCommContext([], { userId: "default", agent: "maestro" })).toEqual({
      userId: "default",
      currentTopic: "",
      currentTopicId: undefined,
      subagentParentTopicId: undefined,
      peerHostQueryId: undefined,
      depth: 0,
      replyOnly: false,
      agent: "maestro",
    });
    expect(() =>
      parseSessionCommContext(["--depth=-1"], { userId: "default", agent: "claude" }),
    ).toThrow("Invalid --depth");
    expect(() =>
      parseSessionCommContext(["--agent=unknown"], { userId: "default", agent: "claude" }),
    ).toThrow("Invalid --agent");
  });
});
