/**
 * Minimal Kakao i Open Builder "skill" webhook contract — only the fields
 * this adapter actually reads/writes. Full reference:
 * https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/answer_json_format
 */

/** The KakaoTalk user who sent the message, as Open Builder represents it. */
export interface KakaoSkillUser {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface KakaoUserRequest {
  timezone?: string;
  utterance: string;
  lang?: string;
  user: KakaoSkillUser;
  /**
   * Present only when the bot's "콜백 사용" option is enabled in Open
   * Builder. The ONE channel this adapter has to answer this specific
   * message, valid for a short window (operator-configured, default up to
   * about a minute) after the request arrives.
   */
  callbackUrl?: string;
  block?: { id: string; name: string };
}

/** Top-level skill request Open Builder POSTs to the registered webhook. */
export interface KakaoSkillRequest {
  intent?: { id: string; name: string };
  userRequest: KakaoUserRequest;
  bot?: { id: string; name: string };
  action?: {
    id: string;
    name: string;
    params?: Record<string, unknown>;
    detailParams?: Record<string, unknown>;
  };
}

export interface KakaoSimpleTextOutput {
  simpleText: { text: string };
}

/** Skill response body — both the synchronous ack and the later callback POST use this shape. */
export interface KakaoSkillResponse {
  version: "2.0";
  /** True on the synchronous ack: "I'll answer later via callbackUrl." */
  useCallback?: boolean;
  /** Optional "thinking…" text shown while useCallback is pending. */
  data?: { text?: string };
  template?: { outputs: KakaoSimpleTextOutput[] };
}

export function kakaoTextResponse(text: string): KakaoSkillResponse {
  return {
    version: "2.0",
    template: { outputs: [{ simpleText: { text } }] },
  };
}
