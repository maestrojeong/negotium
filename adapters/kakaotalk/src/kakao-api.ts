/**
 * Thin client for the one outbound call this adapter needs: answering an
 * Open Builder skill request via its `callbackUrl`.
 *
 * This is NOT the general-purpose "카카오톡 메시지 API" (send-to-self /
 * send-to-friend, `kapi.kakao.com/v2/api/talk/memo/*`) — decision #3 chose
 * the Open Builder channel-bot track, whose only send primitive is replying
 * to a specific pending request. A future `친구톡`/`알림톡` bulk-send
 * integration would live in a sibling module, not here.
 */

import { kakaoTextResponse } from "@/types";

export async function postKakaoCallback(callbackUrl: string, text: string): Promise<void> {
  const res = await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(kakaoTextResponse(text)),
  });
  if (!res.ok) {
    throw new Error(
      `kakao callback POST failed: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
}
