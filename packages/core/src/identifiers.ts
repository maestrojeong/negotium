/** Semantic identifier vocabulary for the canonical runtime.
 *
 * Wire and SQLite representations remain strings. Branding begins at
 * construction boundaries so internal code cannot accidentally exchange ids
 * that merely share the same representation.
 */
declare const identifierKind: unique symbol;

export type Identifier<Kind extends string> = string & {
  readonly [identifierKind]: Kind;
};

export type UserId = Identifier<"UserId">;
export type TopicId = Identifier<"TopicId">;
export type MessageId = Identifier<"MessageId">;
export type RequestId = Identifier<"RequestId">;
export type ClientMessageId = Identifier<"ClientMessageId">;
export type TurnId = Identifier<"TurnId">;
export type ProviderSessionId = Identifier<"ProviderSessionId">;
export type TurnSlotKey = Identifier<"TurnSlotKey">;
export type FileId = Identifier<"FileId">;

export function asUserId(value: string): UserId {
  return value as UserId;
}

export function asTopicId(value: string): TopicId {
  return value as TopicId;
}

export function asMessageId(value: string): MessageId {
  return value as MessageId;
}

export function asRequestId(value: string): RequestId {
  return value as RequestId;
}

export function asClientMessageId(value: string): ClientMessageId {
  return value as ClientMessageId;
}

export function asTurnId(value: string): TurnId {
  return value as TurnId;
}

export function asTurnSlotKey(value: string): TurnSlotKey {
  return value as TurnSlotKey;
}
