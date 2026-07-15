/**
 * Minimal Telegram surface the adapter depends on.
 *
 * The adapter never constructs a Telegram client — the embedding app passes
 * one in. `node-telegram-bot-api`'s `TelegramBot` satisfies
 * {@link TelegramClientLike} structurally (method params are bivariant, so
 * its narrower `SendMessageParams` options type is compatible); tests inject
 * a fake that records sends and replays inbound messages.
 */

export interface TelegramClientLike {
  /** Send a text message. `opts` carries `parse_mode`, `message_thread_id`, … */
  sendMessage(chatId: number, text: string, opts?: Record<string, unknown>): Promise<unknown>;
  /** Edit an already-sent text message. Used to attach terminal turn usage. */
  editMessageText?(text: string, opts: Record<string, unknown>): Promise<unknown>;
  /** Delete a previously-sent message when its runtime source is superseded. */
  deleteMessage?(
    chatId: number,
    messageId: number,
    opts?: Record<string, unknown>,
  ): Promise<unknown>;
  /** Subscribe to incoming messages (long polling or webhook — adapter doesn't care). */
  on(event: "message", handler: (msg: TelegramIncomingMessage) => void): void;
  /** Bot membership changes, used to auto-connect when it is promoted in a forum group. */
  on(event: "my_chat_member", handler: (update: TelegramMyChatMemberUpdate) => void): void;
  /** Identity and membership lookups used by the missed-promotion fallback. */
  getMe?(): Promise<TelegramUser>;
  getChatMember?(chatId: number, userId: number): Promise<TelegramChatMember>;
  /**
   * Forum surface — optional so DM-only bots still satisfy the interface.
   * Required for forum mode ({@link TelegramAdapterOptions.forumChatId}):
   * creates a forum topic (thread) in a supergroup and returns its thread id.
   */
  createForumTopic?(
    chatId: number,
    name: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_thread_id: number }>;
  /** Delete a forum topic (thread). Best-effort in the adapter — failures are logged. */
  deleteForumTopic?(chatId: number, threadId: number): Promise<unknown>;
  /** Resolve a `file_id` to a downloadable URL (Bot API `getFile` + file URL).
   *  Required for inbound attachments; without it media messages degrade to
   *  their caption text. */
  getFileLink?(fileId: string): Promise<string>;
  /** Send a local file as a photo. Optional — when absent the adapter falls
   *  back to {@link TelegramClientLike.sendDocument} or a plain path notice. */
  sendPhoto?(chatId: number, photo: string, opts?: Record<string, unknown>): Promise<unknown>;
  /** Send a local file as a document. */
  sendDocument?(chatId: number, doc: string, opts?: Record<string, unknown>): Promise<unknown>;
  /** Chat action indicator ("typing", …). Best-effort, optional. */
  sendChatAction?(chatId: number, action: string, opts?: Record<string, unknown>): Promise<unknown>;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type?: "private" | "group" | "supergroup" | "channel";
  title?: string;
  is_forum?: boolean;
}

export interface TelegramChatMember {
  status?: string;
  can_manage_topics?: boolean;
  user?: TelegramUser;
}

export interface TelegramMyChatMemberUpdate {
  chat: TelegramChat;
  from?: TelegramUser;
  new_chat_member?: TelegramChatMember;
}

/** The subset of Telegram's `Message` update the adapter reads.
 *  Media shapes mirror node-telegram-bot-api's `Message` fields. */
export interface TelegramIncomingMessage {
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  /** Caption of a media message (photo/document/…). */
  caption?: string;
  /** Photo size variants, smallest first — the adapter downloads the last. */
  photo?: Array<{ file_id: string; width?: number; height?: number; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; duration?: number; mime_type?: string; file_size?: number };
  /** Album id — Telegram splits a multi-photo upload into separate messages
   *  sharing this id; the adapter buffers them into one turn. */
  media_group_id?: string;
  /** Forum topic thread id — present when the message was posted in a forum thread. */
  message_thread_id?: number;
  /** True only when message_thread_id identifies a real forum topic. */
  is_topic_message?: true;
}
