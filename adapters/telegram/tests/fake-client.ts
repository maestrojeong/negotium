import type {
  TelegramChatMember,
  TelegramClientLike,
  TelegramIncomingMessage,
  TelegramMyChatMemberUpdate,
  TelegramUser,
} from "@/types";

export interface SentCall {
  chatId: number;
  text: string;
  opts?: Record<string, unknown>;
}

export interface EditedCall {
  text: string;
  opts: Record<string, unknown>;
}

/**
 * In-memory Telegram double: records sends, replays inbound via `emit`, and
 * implements the optional forum surface with controllable behavior:
 *  - `createMode: "auto"` — threads created immediately (default)
 *  - `createMode: "manual"` — createForumTopic stays pending until
 *    `resolvePendingCreates()` (exercises the adapter's race buffering)
 *  - `createMode: "reject"` — createForumTopic rejects with
 *    `createRejectError` (permission recovery or permanent tombstone path)
 */
export class FakeTelegramClient implements TelegramClientLike {
  /** Successful sends only (what "arrived" in Telegram). */
  calls: SentCall[] = [];
  /** Every sendMessage invocation, including rejected/hung ones. */
  attempts: SentCall[] = [];
  forumCalls: Array<{ chatId: number; name: string }> = [];
  deleteCalls: Array<{ chatId: number; threadId: number }> = [];
  deletedMessageCalls: Array<{ chatId: number; messageId: number }> = [];
  editCalls: EditedCall[] = [];
  photoCalls: Array<{
    chatId: number;
    path: string;
    opts?: Record<string, unknown>;
    fileOptions?: { filename?: string; contentType?: string; knownLength?: number };
  }> = [];
  docCalls: Array<{
    chatId: number;
    path: string;
    opts?: Record<string, unknown>;
    fileOptions?: { filename?: string; contentType?: string; knownLength?: number };
  }> = [];
  chatActions: Array<{ chatId: number; action: string; opts?: Record<string, unknown> }> = [];
  /** fileId → URL served by the test's local Bun.serve. */
  fileLinks = new Map<string, string>();
  /** When true, sends with parse_mode HTML reject like a Telegram 400. */
  rejectHtml = false;
  /** When set, every sendMessage rejects with this error (any parse_mode). */
  failWith: unknown = null;
  /** First `count` sendMessage calls reject with `error`, then sends recover. */
  failNextSends: { count: number; error: unknown } | null = null;
  /** First `count` editMessageText calls reject with `error`, then edits recover. */
  failNextEdits: { count: number; error: unknown } | null = null;
  /** While > 0, HTML sends reject with a node-telegram-bot-api-shaped 429
   *  (retry_after 0) and decrement the counter. */
  rateLimit429Next = 0;
  /** "hang" makes sendMessage never settle (exercises the send watchdog). */
  sendMode: "auto" | "hang" = "auto";
  createMode: "auto" | "manual" | "reject" = "auto";
  createRejectError: unknown = new Error("400 Bad Request: not enough rights to manage topics");
  deleteFailWith: unknown = null;
  nextThreadId = 100;
  nextMessageId = 1;
  private pendingCreates: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private handlers: Array<(msg: TelegramIncomingMessage) => void> = [];
  private memberHandlers: Array<(update: TelegramMyChatMemberUpdate) => void> = [];
  me: TelegramUser = { id: 999_000, is_bot: true, username: "negotium_test_bot" };
  members = new Map<string, TelegramChatMember>();

  sendMessage(chatId: number, text: string, opts?: Record<string, unknown>): Promise<unknown> {
    this.attempts.push({ chatId, text, opts });
    if (this.sendMode === "hang") return new Promise(() => {});
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.failNextSends && this.failNextSends.count > 0) {
      this.failNextSends.count--;
      return Promise.reject(this.failNextSends.error);
    }
    if (this.rateLimit429Next > 0 && opts?.parse_mode === "HTML") {
      this.rateLimit429Next--;
      const err = new Error("ETELEGRAM: 429 Too Many Requests: retry after 0") as Error & {
        response: unknown;
      };
      err.response = {
        statusCode: 429,
        body: { ok: false, error_code: 429, parameters: { retry_after: 0 } },
      };
      return Promise.reject(err);
    }
    if (this.rejectHtml && opts?.parse_mode === "HTML") {
      return Promise.reject(new Error("400 Bad Request: can't parse entities"));
    }
    this.calls.push({ chatId, text, opts });
    return Promise.resolve({ message_id: this.nextMessageId++ });
  }

  editMessageText(text: string, opts: Record<string, unknown>): Promise<unknown> {
    this.editCalls.push({ text, opts });
    if (this.failNextEdits && this.failNextEdits.count > 0) {
      this.failNextEdits.count--;
      return Promise.reject(this.failNextEdits.error);
    }
    return Promise.resolve({});
  }

  deleteMessage(chatId: number, messageId: number): Promise<unknown> {
    this.deletedMessageCalls.push({ chatId, messageId });
    return Promise.resolve(true);
  }

  async getFileLink(fileId: string): Promise<string> {
    const url = this.fileLinks.get(fileId);
    if (!url) throw new Error(`no file link registered for ${fileId}`);
    return url;
  }

  async sendPhoto(
    chatId: number,
    path: string,
    opts?: Record<string, unknown>,
    fileOptions?: { filename?: string; contentType?: string; knownLength?: number },
  ): Promise<unknown> {
    this.photoCalls.push({ chatId, path, opts, fileOptions });
    return { message_id: this.nextMessageId++ };
  }

  async sendDocument(
    chatId: number,
    path: string,
    opts?: Record<string, unknown>,
    fileOptions?: { filename?: string; contentType?: string; knownLength?: number },
  ): Promise<unknown> {
    this.docCalls.push({ chatId, path, opts, fileOptions });
    return { message_id: this.nextMessageId++ };
  }

  async sendChatAction(
    chatId: number,
    action: string,
    opts?: Record<string, unknown>,
  ): Promise<unknown> {
    this.chatActions.push({ chatId, action, opts });
    return true;
  }

  createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number }> {
    this.forumCalls.push({ chatId, name });
    if (this.createMode === "reject") {
      return Promise.reject(this.createRejectError);
    }
    const threadId = this.nextThreadId++;
    if (this.createMode === "auto") return Promise.resolve({ message_thread_id: threadId });
    return new Promise((resolve, reject) => {
      this.pendingCreates.push({
        resolve: () => resolve({ message_thread_id: threadId }),
        reject,
      });
    });
  }

  /** Release createForumTopic promises held back by `createMode: "manual"`. */
  resolvePendingCreates(): void {
    for (const pending of this.pendingCreates.splice(0)) pending.resolve();
  }

  /** Fail createForumTopic promises held back by `createMode: "manual"`. */
  rejectPendingCreates(err: unknown): void {
    for (const pending of this.pendingCreates.splice(0)) pending.reject(err);
  }

  async deleteForumTopic(chatId: number, threadId: number): Promise<unknown> {
    this.deleteCalls.push({ chatId, threadId });
    if (this.deleteFailWith) throw this.deleteFailWith;
    return true;
  }

  getMe(): Promise<TelegramUser> {
    return Promise.resolve(this.me);
  }

  getChatMember(chatId: number, userId: number): Promise<TelegramChatMember> {
    return Promise.resolve(this.members.get(`${chatId}:${userId}`) ?? { status: "member" });
  }

  on(event: "message", handler: (msg: TelegramIncomingMessage) => void): void;
  on(event: "my_chat_member", handler: (update: TelegramMyChatMemberUpdate) => void): void;
  on(
    event: "message" | "my_chat_member",
    handler:
      | ((msg: TelegramIncomingMessage) => void)
      | ((update: TelegramMyChatMemberUpdate) => void),
  ): void {
    if (event === "message") {
      this.handlers.push(handler as (msg: TelegramIncomingMessage) => void);
    } else {
      this.memberHandlers.push(handler as (update: TelegramMyChatMemberUpdate) => void);
    }
  }

  emit(msg: TelegramIncomingMessage): void {
    for (const handler of this.handlers) handler(msg);
  }

  emitMyChatMember(update: TelegramMyChatMemberUpdate): void {
    for (const handler of this.memberHandlers) handler(update);
  }

  callsFor(chatId: number): SentCall[] {
    return this.calls.filter((c) => c.chatId === chatId);
  }
}

/** Poll until `cond` holds (5ms interval) or fail after `ms`. */
export async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor: condition not met in time");
    await Bun.sleep(5);
  }
}
