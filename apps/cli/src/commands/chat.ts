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
  answerPendingAskUserQuestion,
  appendApiMessage,
  getTopicByNameForUser,
  isAgentKind,
  type MessageDto,
  registerTopic,
  runtimeBus,
  startAiTurn,
  type TopicDto,
} from "@negotium/core";
import { startDefaultNode } from "@negotium/node";
import { renderBusEvent } from "@/render";

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

  const node = await startDefaultNode();
  let topic = ensureTopic(topicArg ?? DEFAULT_TOPIC, agentArg);

  console.log(`negotium node on :${node.port} — topic "${topic.title}" (agent: ${topic.agent})`);
  console.log("commands: /switch <topic>, /abort, /quit\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  let pendingAsk: {
    messageId: string;
    choices: NonNullable<MessageDto["askUserQuestion"]>["choices"];
  } | null = null;
  const unsubscribe = runtimeBus().subscribe((event) => {
    renderBusEvent(event, { topicId: topic.id, selfUserId: DEFAULT_USER });
    if (event.topicId !== topic.id) return;
    if (event.type === "message") {
      const msg = event.payload as MessageDto;
      if (msg.kind === "ask_user_question" && msg.askUserQuestion) {
        pendingAsk = { messageId: msg.id, choices: msg.askUserQuestion.choices };
        rl.prompt();
      }
      return;
    }
    if (event.type === "message-updated" && pendingAsk) {
      const payload = event.payload as { messageId?: string; patch?: Partial<MessageDto> };
      if (
        payload.messageId === pendingAsk.messageId &&
        (payload.patch?.askUserQuestion?.expired || payload.patch?.askUserQuestion?.selectedLabel)
      ) {
        pendingAsk = null;
      }
    }
  });

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
      pendingAsk = null;
      console.log(`→ topic "${topic.title}" (agent: ${topic.agent})`);
      rl.prompt();
      return;
    }

    if (pendingAsk) {
      const choiceIndex = /^\d+$/.test(text) ? Number(text) - 1 : -1;
      const choice =
        (choiceIndex >= 0 ? pendingAsk.choices[choiceIndex] : undefined) ??
        pendingAsk.choices.find((item) => item.label === text);
      if (!choice) {
        console.log("invalid choice — enter one of the displayed numbers or labels.");
        rl.prompt();
        return;
      }
      const answered = answerPendingAskUserQuestion(
        topic.id,
        pendingAsk.messageId,
        choice.label,
        DEFAULT_USER,
      );
      if (!answered.ok) {
        console.log(`could not answer: ${answered.error}`);
      } else {
        pendingAsk = null;
      }
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
    rl.on("close", async () => {
      unsubscribe();
      await node.stop();
      resolve();
    });
  });
}
