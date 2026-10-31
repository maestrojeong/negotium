# @negotium/adapter-kakaotalk

Turns a Negotium Node into a KakaoTalk bot, through TWO transports that both
feed the same single "kakaotalk" manager topic (decision A):

- **Open Builder** — the official Kakao i Open Builder chatbot API. 1:1 chat
  with the channel only; Kakao's skill payload has no room/chat id at all
  (devtalk.kakao.com/t/topic/133154), so this transport structurally cannot
  reach group or open-chat rooms.
- **LOCO** (`src/loco/`, opt-in, off by default) — a real personal KakaoTalk
  account's session, speaking Kakao's actual client protocol directly
  (vendored/forked from the MIT-licensed
  [NetRiceCake/loco-wrapper](https://github.com/NetRiceCake/loco-wrapper) —
  see `loco-sidecar/LICENSE.upstream`). This is what makes group/open-chat
  rooms possible at all — Kakao does not officially support third-party bots
  participating in them (no Open Chat API, by Kakao's own design, for
  privacy/anti-spam reasons).

## ⚠️ LOCO is unofficial and carries real account risk

Unlike Open Builder (an official, sanctioned integration), LOCO logs in as a
**real personal KakaoTalk account** and talks to Kakao's servers using a
reverse-engineered protocol — this **violates Kakao's Terms of Service**.
Kakao actively detects and fights this class of client (the upstream
`node-kakao` project's own README: abusing a LOCO client "can cause
permanent service restriction"; it dropped open-chat-room support entirely
in v4.5.0 specifically due to abuse). Before enabling it:

- **Use a sub-account, not your main one.** A suspension here should not be
  able to take out your real KakaoTalk identity.
- It can **break without warning** whenever Kakao changes the protocol (this
  fork was patched once already, in October 2026, for Kakao's V2SL→TLS
  transport migration — see `loco-sidecar`'s git history).
- **You are responsible for maintaining the fork.** `loco-sidecar/` is
  vendored, not an external dependency with a release channel — protocol
  changes from Kakao require patching `loco-sidecar/src/main/java/com/github/netricecake/kakao/`
  directly.

## Design (recorded as decisions #1–#3, plus decision A, in this topic)

- **One persistent topic, not one per chat — now across BOTH transports.**
  `kind: "manager"`, `surface: "kakaotalk"`, title `"kakaotalk"` — created
  once per node, never deletable through the normal delete path, shown in
  its own "KakaoTalk" section of the TUI topic picker (mirrors how cron gets
  its own section). LOCO messages are tagged with `[room name · room type]`
  in the transcript so the model can tell rooms apart in the shared backlog.
- **Word-triggered, not `aiMode: "mention"`.** KakaoTalk has no platform
  `@mention` syntax, so inbound messages only become an AI turn when their
  text contains the trigger word (default `"lumi"`, this node's assistant
  name). Every inbound message is still persisted into the topic transcript
  either way (unless rejected by the allowlist below — those never touch
  the transcript at all).
- **Multi-message backlog, not the single triggering line.** On trigger, the
  turn prompt is every kakaotalk message recorded since the topic's last AI
  reply (oldest messages dropped first if that's too large), wrapped with an
  instruction to treat it as context and focus on the latest question.
- **Tool-driven outbound, not auto-relay.** There is no telegram-style "every
  AI reply gets sent back automatically." The agent must explicitly call the
  `send_kakaotalk` tool, which is only ever present in the kakaotalk topic's
  own tool catalog. It works regardless of which transport the trigger came
  in on — it tries the Open Builder callback first, then the LOCO reply
  target.
- **Fail-closed allowlists on both transports.** Open Builder can only
  filter by sender id (no room id exists to filter on). LOCO gets a real
  `chatId`, so it supports sender AND room allowlists — set either or both;
  when both are set, BOTH must match (AND, not OR).

## Design (recorded as decisions #1–#3 in this topic)

- **One persistent topic, not one per chat.** `kind: "manager"`,
  `surface: "kakaotalk"`, title `"kakaotalk"` — created once per node, never
  deletable through the normal delete path, pinned under the Manager section
  of the TUI topic picker.
- **Word-triggered, not `aiMode: "mention"`.** KakaoTalk has no platform
  `@mention` syntax, so inbound messages only become an AI turn when their
  text contains the trigger word (default `"lumi"`, this node's assistant
  name). Every inbound message is still persisted into the topic transcript
  either way.
- **Multi-message backlog, not the single triggering line.** On trigger, the
  turn prompt is every kakaotalk message recorded since the topic's last AI
  reply (oldest messages dropped first if that's too large), wrapped with an
  instruction to treat it as context and focus on the latest question.
- **Tool-driven outbound, not auto-relay.** There is no telegram-style "every
  AI reply gets sent back automatically." The agent must explicitly call the
  `send_kakaotalk` tool, which is only ever present in the kakaotalk topic's
  own tool catalog.

## Known constraint

Open Builder only lets a skill server answer within the window of the ONE
inbound request that supplied its `callbackUrl` (operator-configured in Open
Builder, default well under a minute), and only once. `send_kakaotalk` fails
outside that window — there is no general "message this user whenever you
want" endpoint for a channel chatbot. A proactive-push use case would need a
separate 친구톡/알림톡 (bulk business messaging) integration later.

## Setup this adapter does NOT automate (manual Kakao Developers Console / Open Builder steps)

1. **카카오 디벨로퍼스**: create an app (developers.kakao.com → 앱 생성).
2. **카카오톡 채널**: create a Kakao Channel (center-pf.kakao.com) if you
   don't already have one, and link it to the app.
3. **카카오 i 오픈빌더** (i-builder.kakao.com): create a bot connected to
   that channel, add a **스킬(Skill)** whose server URL is this node's public
   HTTPS endpoint at `/webhooks/kakaotalk` (`KAKAOTALK_WEBHOOK_PATH`), enable
   **콜백 사용 (use callback)** in the bot's settings, and route the
   폴백 블록 (fallback block, so every utterance reaches the skill) to it.
4. **Public HTTPS**: this node's HTTP server binds to `127.0.0.1` only
   (`packages/node/src/index.ts`) — put a reverse proxy or tunnel (ngrok,
   Cloudflare Tunnel, etc.) in front of it and use that public URL in step 3.
5. **배포**: publish the Open Builder scenario so the skill is live.

## LOCO setup (opt-in — read the risk section above first)

1. **Build the sidecar once**: `cd loco-sidecar && ./gradlew build` (needs a
   JDK 21+; `JAVA_HOME` must point at it) — produces
   `loco-sidecar/build/libs/kakaotalk-loco-sidecar-1.0-SNAPSHOT.jar`, the
   default `locoJarPath`.
2. **Credentials**: set `NEGOTIUM_KAKAOTALK_LOCO_EMAIL` (plain env is fine,
   it's not secret) and store the account password in the node's Vault under
   `KAKAOTALK_PWD` — `packages/node/src/index.ts` prefers that over
   `NEGOTIUM_KAKAOTALK_LOCO_PASSWORD` (plaintext env) when both exist, since
   this is a real account password, not a trigger word.
3. **Device UUID**: generate one 64-char hex string once
   (`openssl rand -hex 32`) and keep it stable in
   `NEGOTIUM_KAKAOTALK_LOCO_DEVICE_UUID` — it's this sub-device's identity to
   Kakao; changing it looks like a new device every time.
4. **First run — one-time device approval**: the daemon will log a passcode
   (`kakaotalk adapter: LOCO device needs one-time approval`) — open
   KakaoTalk on your **already-trusted phone** and enter it within the
   printed window. This is effectively Kakao's own 2FA for a new device; it
   only happens once per device UUID.
5. **Allowlist**: set at least one of
   `NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_USER_IDS` /
   `NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_CHAT_IDS` (both numeric, comma-separated
   — see src/loco/env-auth.ts). Node startup refuses to enable LOCO without
   at least one. You'll only learn the right chat id / your own user id from
   the `locoUserId`/`locoChatId` fields the node logs for a rejected message
   once it's running — same bootstrap-from-logs pattern as the Open Builder
   allowlist.
6. **Invite the account to a room**: add the LOCO account (your sub-account)
   to whatever group/open-chat room you want it answering in, same as
   adding any other person.

| Env var | Required | Notes |
|---|---|---|
| `NEGOTIUM_KAKAOTALK_LOCO_EMAIL` | to enable LOCO at all | email or phone |
| `NEGOTIUM_KAKAOTALK_LOCO_PASSWORD` | only if not in Vault | prefer Vault `KAKAOTALK_PWD` |
| `NEGOTIUM_KAKAOTALK_LOCO_DEVICE_UUID` | yes, once enabled | 64-char hex, generate once, keep stable |
| `NEGOTIUM_KAKAOTALK_LOCO_DEVICE_NAME` | no | defaults to a sub-device-login-capable tablet model |
| `NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_USER_IDS` | at least one of these two | numeric LOCO `userId`s |
| `NEGOTIUM_KAKAOTALK_LOCO_ALLOWED_CHAT_IDS` | at least one of these two | numeric LOCO `chatId`s |

## Usage

```ts
import { parseKakaoTalkLocoAuthEnv, startKakaoTalkAdapter } from "@negotium/adapter-kakaotalk";

const handle = startKakaoTalkAdapter({
  userId: "local", // default
  triggerWord: "lumi", // default
  loco: parseKakaoTalkLocoAuthEnv(process.env), // { enabled: false } unless configured
});

// later
handle.stop();
```

Call this after the node's HTTP server + MCP runtime are up (same ordering
constraint as every other `registerNodeRequestHandler`/`registerRuntimeMcpServer`
caller).
