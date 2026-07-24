import {
  type AgentKind,
  errMsg,
  executeVaultCommand,
  getTopic,
  getTopicByNameForUser,
  isAgentKind,
  isTopicVisible,
  isVaultCommandLine,
  listTopics,
  type RegisterTopicOptions,
  TopicArchiveRequiredError,
  type TopicDto,
  TopicTitleConflictError,
  TopicValidationError,
  topicService,
} from "@negotium/core";
import { extractCommandArg } from "@/telegram-api";

export interface TelegramCommandContext {
  userId: string;
  defaultAgent?: AgentKind;
  forum?: { enabled: boolean; chatId: number };
  resolveBotUsername: () => Promise<string | undefined>;
  isVaultOwner: (telegramUserId?: number) => boolean;
  reply: (chatId: number, threadId: number | undefined, text: string) => void;
  sendOnboardingGuide: (chatId: number, threadId?: number) => Promise<void>;
  currentTopicId: (chatId: number, threadId?: number) => string | undefined;
  titleFor: (chatId: number, threadId?: number) => string;
  getOrCreateTopic: (title: string, agent: AgentKind) => TopicDto;
  bindMapping: (chatId: number, threadId: number | undefined, topicId: string) => void;
  registerTopic: (options: RegisterTopicOptions) => TopicDto;
  loadTopic: (chatId: number, topicId: string, threadId?: number) => boolean;
  unloadTopic: (chatId: number, threadId?: number) => boolean;
  abortTurn: (topicId: string) => Promise<boolean>;
}

export type TelegramCommandRouter = (
  text: string,
  chatId: number,
  threadId?: number,
  telegramUserId?: number,
) => Promise<void>;

export function createTelegramCommandRouter(
  context: TelegramCommandContext,
): TelegramCommandRouter {
  const { userId, reply, currentTopicId, bindMapping, loadTopic, unloadTopic, abortTurn } = context;

  return async function handleCommand(
    text: string,
    chatId: number,
    threadId?: number,
    telegramUserId?: number,
  ): Promise<void> {
    const [rawCommand = ""] = text.split(/\s+/);
    const addressedUsername = rawCommand.match(/@(\w+)$/)?.[1];
    if (addressedUsername) {
      const botUsername = await context.resolveBotUsername();
      if (!botUsername || botUsername.toLowerCase() !== addressedUsername.toLowerCase()) return;
    }

    if (isVaultCommandLine(text)) {
      if (!context.isVaultOwner(telegramUserId)) return;
      const vaultResponse = executeVaultCommand(userId, text);
      if (vaultResponse !== null) reply(chatId, threadId, vaultResponse);
      return;
    }

    const command = rawCommand.replace(/@\w+$/, "");
    const argument = extractCommandArg(text);
    switch (command) {
      case "/start":
        await context.sendOnboardingGuide(chatId, threadId);
        return;
      case "/abort": {
        const topicId = currentTopicId(chatId, threadId);
        const aborted = topicId ? await abortTurn(topicId) : false;
        reply(chatId, threadId, aborted ? "aborted" : "nothing running");
        return;
      }
      case "/agent": {
        if (!isAgentKind(argument)) {
          reply(chatId, threadId, "usage: /agent <claude|codex|maestro>");
          return;
        }
        try {
          const topic = context.getOrCreateTopic(
            `${context.titleFor(chatId, threadId)}-${argument}`,
            argument,
          );
          bindMapping(chatId, threadId, topic.id);
          reply(chatId, threadId, `agent set to ${argument} — topic "${topic.title}"`);
        } catch (err) {
          reply(chatId, threadId, errMsg(err, "agent switch failed"));
        }
        return;
      }
      case "/topics": {
        const topics = listTopics().filter(
          (topic) =>
            isTopicVisible(topic) && topic.participants.some((person) => person.userId === userId),
        );
        reply(
          chatId,
          threadId,
          topics.length
            ? topics
                .map((topic) => `- ${topic.title}${topic.agent ? ` (${topic.agent})` : ""}`)
                .join("\n")
            : "no topics",
        );
        return;
      }
      case "/new": {
        if (!argument) {
          const topicId = currentTopicId(chatId, threadId);
          const topic = topicId ? getTopic(topicId) : null;
          if (!topic) {
            reply(chatId, threadId, "nothing to reset — this chat has no topic yet");
            return;
          }
          try {
            const result = await topicService.reset({
              topicId: topic.id,
              userId,
              reason: "telegram-session-reset",
            });
            reply(chatId, threadId, result.text);
          } catch (err) {
            reply(chatId, threadId, errMsg(err, "session reset failed"));
          }
          return;
        }
        try {
          const createOptions: RegisterTopicOptions = {
            title: argument,
            userId,
            kind: "agent",
            ...(context.defaultAgent ? { agent: context.defaultAgent } : {}),
          };
          const fromForumGeneral =
            context.forum?.enabled === true &&
            chatId === context.forum.chatId &&
            threadId === undefined;
          const topic = fromForumGeneral
            ? topicService.create(createOptions)
            : context.registerTopic(createOptions);
          if (fromForumGeneral) {
            reply(chatId, threadId, `creating new topic "${topic.title}"`);
            return;
          }
          bindMapping(chatId, threadId, topic.id);
          reply(chatId, threadId, `switched to new topic "${topic.title}"`);
        } catch (err) {
          reply(
            chatId,
            threadId,
            err instanceof TopicValidationError ? err.message : errMsg(err, "topic create failed"),
          );
        }
        return;
      }
      case "/load": {
        if (!argument) {
          reply(chatId, threadId, "usage: /load <topic>");
          return;
        }
        const candidate = getTopicByNameForUser(argument, userId) ?? getTopic(argument);
        const topic = candidate && isTopicVisible(candidate) ? candidate : null;
        if (!topic || !loadTopic(chatId, topic.id, threadId)) {
          reply(chatId, threadId, `no visible topic matching "${argument}"`);
          return;
        }
        reply(chatId, threadId, `loaded topic "${topic.title}"`);
        return;
      }
      case "/unload":
        if (!unloadTopic(chatId, threadId)) {
          reply(chatId, threadId, "this chat has no loaded topic");
          return;
        }
        reply(chatId, threadId, "unloaded topic; the Negotium topic was preserved");
        return;
      case "/fork":
      case "/spawn": {
        const label = command.slice(1);
        const topicId = currentTopicId(chatId, threadId);
        if (!topicId) {
          reply(chatId, threadId, `nothing to ${label} — this chat has no topic yet`);
          return;
        }
        const copyHistory = command === "/fork";
        void topicService
          .derive({
            sourceTopicId: topicId,
            userId,
            copyHistory,
            ...(argument ? { name: argument } : {}),
          })
          .then((derived) => {
            if (!derived) {
              reply(chatId, threadId, `${label} failed`);
              return;
            }
            reply(
              chatId,
              threadId,
              `${copyHistory ? "forked into" : "spawned"} "${derived.title}"`,
            );
          })
          .catch((err) => {
            reply(
              chatId,
              threadId,
              err instanceof TopicTitleConflictError ? err.message : errMsg(err, `${label} failed`),
            );
          });
        return;
      }
      case "/del":
      case "/del!": {
        const force = command === "/del!";
        const topicId = currentTopicId(chatId, threadId);
        const topic = argument
          ? getTopicByNameForUser(argument, userId)
          : topicId
            ? getTopic(topicId)
            : null;
        if (!topic) {
          reply(
            chatId,
            threadId,
            argument
              ? `no topic named "${argument}"`
              : "this chat has no topic — usage: /del [name]",
          );
          return;
        }
        reply(chatId, threadId, `deleting topic "${topic.title}"…`);
        void topicService.delete({ topicId: topic.id, userId, force }).catch((err) => {
          if (err instanceof TopicArchiveRequiredError) {
            reply(
              chatId,
              threadId,
              `delete blocked: archiving "${topic.title}" failed and deleting now would lose its history. ` +
                `Retry after fixing the archive, or force with: /del!${argument ? ` ${argument}` : ""}`,
            );
          } else {
            reply(chatId, threadId, errMsg(err, "delete failed"));
          }
        });
        return;
      }
      default:
        reply(
          chatId,
          threadId,
          "commands: /new [name], /topics, /agent <claude|codex|maestro>, " +
            "/load <topic>, /unload, /fork [name], /spawn [name], " +
            "/del [name], /del! [name], /abort, /vault <list|set|del>",
        );
    }
  };
}
