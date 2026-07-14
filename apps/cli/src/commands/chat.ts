/**
 * `negotium chat [topic]` — interactive terminal host.
 *
 * This command doubles as the reference implementation for anyone writing a
 * channel adapter: everything it does (ensure topic → persist user message →
 * startAiTurn → render bus events) is exactly what a Telegram/web/otium host
 * does with a different renderer.
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  type AgentKind,
  abortRoom,
  appendApiMessage,
  getTopicByNameForUser,
  isAgentKind,
  registerTopic,
  runtimeBus,
  startAiTurn,
  type TopicDto,
} from "@negotium/core";
import { startNode } from "../node";
import { renderBusEvent } from "../render";

const DEFAULT_USER = "local";
const DEFAULT_TOPIC = "chat";

function ensureTopic(title: string, agent?: string): TopicDto {
  const existing = getTopicByNameForUser(title, DEFAULT_USER);
  if (existing) return existing;
  return registerTopic({
    title,
    userId: DEFAULT_USER,
    kind: "agent",
    ...(agent && isAgentKind(agent) ? { agent: agent as AgentKind } : {}),
  });
}

export async function chatCommand(args: string[]): Promise<void> {
  const topicArg = args.find((a) => !a.startsWith("--"));
  const agentArg = args.find((a) => a.startsWith("--agent="))?.slice("--agent=".length);

  const node = startNode();
  let topic = ensureTopic(topicArg ?? DEFAULT_TOPIC, agentArg);

  console.log(`negotium node on :${node.port} — topic "${topic.title}" (agent: ${topic.agent})`);
  console.log("commands: /switch <topic>, /abort, /quit\n");

  const unsubscribe = runtimeBus().subscribe((event) =>
    renderBusEvent(event, { topicId: topic.id, selfUserId: DEFAULT_USER }),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (text === "/quit" || text === "/exit") {
      rl.close();
      return;
    }
    if (text === "/abort") {
      const aborted = abortRoom(topic.id);
      console.log(aborted ? "aborted." : "nothing running.");
      rl.prompt();
      return;
    }
    if (text.startsWith("/switch ")) {
      topic = ensureTopic(text.slice("/switch ".length).trim(), agentArg);
      console.log(`→ topic "${topic.title}" (agent: ${topic.agent})`);
      rl.prompt();
      return;
    }

    appendApiMessage({
      id: randomUUID(),
      topicId: topic.id,
      authorId: DEFAULT_USER,
      text,
      createdAt: new Date().toISOString(),
    });
    startAiTurn({ topic, userId: DEFAULT_USER, prompt: text, allowAutoContinue: true });
    rl.prompt();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      unsubscribe();
      node.stop();
      resolve();
    });
  });
}
