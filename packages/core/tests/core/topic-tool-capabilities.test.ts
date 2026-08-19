import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { submitRuntimeGatewayTurn } from "#application/submit-runtime-gateway-turn";
import { topicService } from "#application/topic-service";
import { deleteTopic, getTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import { cancelRuntimeUserTurnRequests } from "#storage/runtime-turn-requests";
import { getTopicToolCapabilities } from "#storage/topic-tool-capabilities";

/**
 * A capability describes the surface a room is rendered on, but only a user
 * turn carries it. `triggerTopicAiTurn` — tell/ask, cron, subagent reports,
 * config-change auto-continue — starts a turn with no adapter, so every one of
 * those lost the tools: a scheduled job in an Otium room could not draw a
 * chart into the panel sitting right in front of the user.
 *
 * The grant is therefore recorded on the room by the turns that do carry it.
 */
test("a gateway turn records the room's granted capabilities for adapter-less turns", () => {
  const userId = `caps-${randomUUID()}`;
  const topic = topicService.create({
    title: `Caps ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    expect(getTopicToolCapabilities(topic.id)).toBeNull();

    submitRuntimeGatewayTurn({
      topic: getTopic(topic.id)!,
      userId,
      text: "draw a chart",
      clientMessageId: randomUUID(),
      visualTools: true,
      fileDeliveryTools: true,
    });
    expect(getTopicToolCapabilities(topic.id)).toEqual({
      visualTools: true,
      fileDeliveryTools: true,
    });

    // Re-recorded per turn, not pinned at room creation: a host that stops
    // rendering a surface stops granting it from its next turn.
    submitRuntimeGatewayTurn({
      topic: getTopic(topic.id)!,
      userId,
      text: "and again",
      clientMessageId: randomUUID(),
      visualTools: false,
      fileDeliveryTools: true,
    });
    expect(getTopicToolCapabilities(topic.id)).toEqual({
      visualTools: false,
      fileDeliveryTools: true,
    });
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    db.query("DELETE FROM runtime_gateway_submissions WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM runtime_events WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topic.id);
    deleteTopic(topic.id);
  }
});

/**
 * A host that never grants must stay default-deny. This is why the grant is
 * recorded rather than derived from `topic.surface`: deriving would hand the
 * tools to any host serving an `otium` room, including one too old to carry a
 * node's rendered visual back to its panel.
 */
test("a gateway that grants nothing leaves the room denied", () => {
  const userId = `caps-deny-${randomUUID()}`;
  const topic = topicService.create({
    title: `Caps deny ${randomUUID()}`,
    userId,
    agent: "codex",
  });
  try {
    submitRuntimeGatewayTurn({
      topic: getTopic(topic.id)!,
      userId,
      text: "plain",
      clientMessageId: randomUUID(),
    });
    expect(getTopicToolCapabilities(topic.id)).toEqual({
      visualTools: false,
      fileDeliveryTools: false,
    });
  } finally {
    cancelRuntimeUserTurnRequests(topic.id);
    db.query("DELETE FROM runtime_gateway_submissions WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM runtime_events WHERE topic_id = ?").run(topic.id);
    db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topic.id);
    deleteTopic(topic.id);
  }
});
