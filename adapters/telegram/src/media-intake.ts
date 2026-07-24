import {
  composeAttachmentPrompt,
  errMsg,
  type IngestedAttachment,
  ingestAttachment,
  logger,
  type TopicDto,
} from "@negotium/core";
import type { TelegramClientLike, TelegramIncomingMessage } from "@/types";

export interface TelegramMediaIntakeOptions {
  client: Pick<TelegramClientLike, "getFileLink">;
  mediaGroup?: {
    debounceMs?: number;
    maxWaitMs?: number;
  };
  isStopped: () => boolean;
  mappingKey: (chatId: number, threadId?: number) => string;
  resolveTopic: (chatId: number, threadId?: number) => TopicDto;
  runTurn: (topic: TopicDto, prompt: string, chatId: number, threadId: number | undefined) => void;
  reply: (chatId: number, threadId: number | undefined, text: string) => void;
  transcribe: (filePath: string) => Promise<string | null>;
  transcriptionAvailable: () => boolean;
}

export interface TelegramMediaIntake {
  enqueue(chatId: number, threadId: number | undefined, task: () => Promise<void> | void): void;
  handleMessage(
    msg: TelegramIncomingMessage,
    chatId: number,
    threadId: number | undefined,
  ): Promise<void>;
  bufferGroup(msg: TelegramIncomingMessage, chatId: number, threadId: number | undefined): void;
  stop(): void;
}

interface MediaGroupEntry {
  messages: TelegramIncomingMessage[];
  chatId: number;
  threadId?: number;
  firstSeenAt: number;
  timer: ReturnType<typeof setTimeout>;
  ready: Promise<void>;
  release: () => void;
}

export function createTelegramMediaIntake(
  options: TelegramMediaIntakeOptions,
): TelegramMediaIntake {
  const {
    client,
    isStopped,
    mappingKey,
    resolveTopic,
    runTurn,
    reply,
    transcribe,
    transcriptionAvailable,
  } = options;
  const inboundQueues = new Map<string, Promise<void>>();
  const mediaGroups = new Map<string, MediaGroupEntry>();
  const mediaGroup = {
    debounceMs: options.mediaGroup?.debounceMs ?? 1_000,
    maxWaitMs: options.mediaGroup?.maxWaitMs ?? 3_000,
  };

  function enqueue(
    chatId: number,
    threadId: number | undefined,
    task: () => Promise<void> | void,
  ): void {
    const key = mappingKey(chatId, threadId);
    const previous = inboundQueues.get(key);
    const run = async (): Promise<void> => {
      if (isStopped()) return;
      await task();
    };
    // Preserve the first task's synchronous prefix; only later arrivals need
    // a promise hop to retain chat/thread arrival order.
    const next = (previous ? previous.catch(() => {}).then(run) : run()).catch((err) =>
      logger.warn({ err, chatId, threadId }, "telegram adapter: inbound task failed"),
    );
    inboundQueues.set(key, next);
    void next.then(() => {
      if (inboundQueues.get(key) === next) inboundQueues.delete(key);
    });
  }

  async function downloadToTopic(
    topicId: string,
    fileId: string,
    filename: string,
  ): Promise<IngestedAttachment> {
    const url = await client.getFileLink!(fileId);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`attachment download failed: HTTP ${response.status}`);
    return ingestAttachment({
      topicId,
      filename,
      bytes: new Uint8Array(await response.arrayBuffer()),
    });
  }

  async function ingestMessageFiles(
    topicId: string,
    msg: TelegramIncomingMessage,
  ): Promise<string[]> {
    const lines: string[] = [];
    if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1]!;
      lines.push((await downloadToTopic(topicId, photo.file_id, "photo.jpg")).promptLine);
    }
    if (msg.document) {
      const filename = msg.document.file_name || "file";
      lines.push((await downloadToTopic(topicId, msg.document.file_id, filename)).promptLine);
    }
    return lines;
  }

  async function handleMessage(
    msg: TelegramIncomingMessage,
    chatId: number,
    threadId: number | undefined,
  ): Promise<void> {
    const caption = (msg.text ?? msg.caption ?? "").trim();
    const topic = resolveTopic(chatId, threadId);

    if (typeof client.getFileLink !== "function") {
      logger.warn(
        { chatId },
        "telegram adapter: media message but client lacks getFileLink — caption only",
      );
      if (caption) runTurn(topic, caption, chatId, threadId);
      else reply(chatId, threadId, "this bot cannot download attachments");
      return;
    }

    let promptLines: string[] = [];
    let voiceText = "";
    try {
      promptLines = await ingestMessageFiles(topic.id, msg);
      if (msg.voice) {
        if (!transcriptionAvailable()) {
          reply(
            chatId,
            threadId,
            "voice transcription is not configured on this bot — please send text",
          );
        } else {
          const ingested = await downloadToTopic(topic.id, msg.voice.file_id, "voice.ogg");
          const transcript = (await transcribe(ingested.path))?.trim();
          if (transcript) voiceText = `[Voice transcript]\n${transcript}`;
          else reply(chatId, threadId, "voice transcription failed — please send text");
        }
      }
    } catch (err) {
      logger.warn({ err, chatId, topicId: topic.id }, "telegram adapter: attachment intake failed");
      reply(chatId, threadId, errMsg(err, "attachment download failed"));
    }
    if (isStopped()) return;

    const userText = voiceText ? (caption ? `${voiceText}\n\n${caption}` : voiceText) : caption;
    if (!userText && promptLines.length === 0) return;
    runTurn(topic, composeAttachmentPrompt(userText, promptLines), chatId, threadId);
  }

  function flushGroup(key: string): void {
    const entry = mediaGroups.get(key);
    if (!entry) return;
    mediaGroups.delete(key);
    entry.release();
  }

  function bufferGroup(
    msg: TelegramIncomingMessage,
    chatId: number,
    threadId: number | undefined,
  ): void {
    const key = `${chatId}:${msg.media_group_id}`;
    const existing = mediaGroups.get(key);
    if (existing) {
      existing.messages.push(msg);
      clearTimeout(existing.timer);
      const remaining = existing.firstSeenAt + mediaGroup.maxWaitMs - Date.now();
      existing.timer = setTimeout(
        () => flushGroup(key),
        Math.max(0, Math.min(mediaGroup.debounceMs, remaining)),
      );
      return;
    }

    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry: MediaGroupEntry = {
      messages: [msg],
      chatId,
      ...(threadId !== undefined ? { threadId } : {}),
      firstSeenAt: Date.now(),
      timer: setTimeout(
        () => flushGroup(key),
        Math.min(mediaGroup.debounceMs, mediaGroup.maxWaitMs),
      ),
      ready,
      release,
    };
    mediaGroups.set(key, entry);
    enqueue(chatId, threadId, async () => {
      await entry.ready;
      if (!isStopped()) await handleGroupFlush(entry);
    });
  }

  async function handleGroupFlush(entry: MediaGroupEntry): Promise<void> {
    const { messages, chatId, threadId } = entry;
    const topic = resolveTopic(chatId, threadId);
    const captions = messages
      .map((message) => (message.text ?? message.caption ?? "").trim())
      .filter((caption) => caption.length > 0);

    if (typeof client.getFileLink !== "function") {
      logger.warn(
        { chatId },
        "telegram adapter: media group but client lacks getFileLink — captions only",
      );
      if (captions.length > 0) runTurn(topic, captions.join("\n"), chatId, threadId);
      else reply(chatId, threadId, "this bot cannot download attachments");
      return;
    }

    const promptLines: string[] = [];
    for (const message of messages) {
      try {
        promptLines.push(...(await ingestMessageFiles(topic.id, message)));
      } catch (err) {
        logger.warn(
          { err, chatId, topicId: topic.id },
          "telegram adapter: media group attachment intake failed",
        );
        reply(chatId, threadId, errMsg(err, "attachment download failed"));
      }
    }
    if (isStopped()) return;
    const userText = captions.join("\n");
    if (!userText && promptLines.length === 0) return;
    runTurn(topic, composeAttachmentPrompt(userText, promptLines), chatId, threadId);
  }

  function stop(): void {
    for (const entry of mediaGroups.values()) {
      clearTimeout(entry.timer);
      entry.release();
    }
    mediaGroups.clear();
    inboundQueues.clear();
  }

  return { enqueue, handleMessage, bufferGroup, stop };
}
