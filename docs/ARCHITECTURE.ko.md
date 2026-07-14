# negotium 아키텍처 — 목적과 원리

> 대상 독자: 이 레포를 유지보수할 사람. 코드를 읽기 전에 이 문서로 지도를 잡는다.

## 1. 이 코드는 무엇을 위해 존재하는가

**"컴퓨터 한 대 = 에이전트 노드 하나"를 만드는 런타임.**

- clawgram은 "Telegram 봇 + 멀티에이전트"였고, otium runtime-api는 그걸 "REST/WS 서버 + 멀티에이전트"로 재편한 것이다.
- negotium은 그 둘의 공통 엔진을 **채널 독립적으로** 추출한 것이다. 채널(Telegram, 터미널, otium 앱)은
  전부 얇은 어댑터고, 엔진은 하나다.
- 오픈소스 목적: 누구든 `@negotium/core`를 임베드하고 어댑터 두 함수를 쓰면 자기만의
  clawgram을 만들 수 있어야 한다.

계보를 알면 코드가 읽힌다: **clawgram → runtime-api → negotium** 순서로 진화했고,
negotium의 파일 대부분은 runtime-api에서 이식됐다 (`api/`·`peer/` 레이어만 제거).
원본과 diff가 궁금하면 `~/otium/apps/runtime-api/src`와 비교하라.

## 2. 다섯 개의 개념이 전부다

| 개념 | 무엇 | 코드 위치 |
|---|---|---|
| **Topic** | 대화방이자 작업 단위. agent(claude/codex/maestro), model, effort, 자기 워크스페이스 디렉토리를 가짐 | `storage/api-topics.ts`, `topics/` |
| **Turn** | 한 토픽에서 프롬프트 하나를 에이전트가 처리하는 실행 단위. **방마다 동시에 최대 1개** | `runtime/turn-runner.ts` |
| **RuntimeBus** | 런타임 → 호스트 방향의 유일한 출구. 채널은 이걸 구독해서 렌더링 | `bus.ts` |
| **Inbox 큐** | 외부/토픽 간 메시지의 유일한 입구(직접 턴 시작 제외). 파일 기반 at-least-once | `runtime/inbox.ts`, `outbox/` |
| **MCP 카탈로그** | 턴마다 에이전트에게 마운트되는 도구 서버 목록. 노드가 가진 능력의 정의 | `platform/mcp-config.ts` |

## 3. 턴의 생애 (제일 중요한 흐름)

```
호스트: appendApiMessage(사용자 메시지) → startAiTurn(topic, prompt)
  1. decideNewQuery(active-rooms) — 방이 바쁘면?
       · 들어온 게 사용자 턴 → 돌던 턴 abort하고 교체 (사용자 우선)
       · 들어온 게 inject(토픽 간 메시지) → defer 큐에 대기
  2. 설정 해석: topic config override > topic default > registry 기본값
  3. MCP 카탈로그 빌드(getMcpServersForQuery) + runtime MCP 토큰 발급(턴 컨텍스트 서명)
  4. runAgent(provider) → UnifiedEvent 스트림
  5. 이벤트마다: conversations JSONL 영속 + api-messages 저장 + bus 브로드캐스트
  6. finally: 방 해제 → defer 큐 드레인(대기 중이던 inject 실행)
```

원리적 불변식 (깨면 안 되는 것):
- **방당 턴 1개.** 동시성 문제의 90%를 이 불변식이 없앤다.
- **사용자 > inject 우선순위.** 사용자 메시지는 돌던 것을 끊고, inject는 기다린다.
- **세션 만료 1회 재시도.** provider 세션이 죽으면 rollout 파일로 세션을 재구성해 한 번만 재시도.
- **requestId 중복 제거.** 큐가 at-least-once라 재전달이 오면 requestId로 걸러낸다.

## 4. 토픽 간 대화의 원리 (tell / ask / spawn)

모두 "인박스 큐 → 드레인 → 턴"으로 수렴한다:

- **tell** (fire-and-forget): 대상 토픽 인박스에 JSONL 엔트리 append → 인박스 워커가
  드레인 → 대상이 idle이면 즉시 턴, 바쁘면 defer 큐. 결과는 회신되지 않는다.
- **ask** (read-only 질의): 대상 세션을 **fork**해서 silent 턴을 돌리고, 등록해둔
  ask-callback으로 답이 **발신 토픽에 자동 주입**된다. 원본 세션은 오염되지 않는다.
- **spawn_subagent**: `createDerivedTopic`으로 자식 토픽 생성(subagent 마킹, MCP 화이트리스트
  비상속 = 재귀 차단) → 자식 턴 fire-and-forget → 자식 턴이 끝나면 turn-runner가
  `settleSubagentSuccess`를 호출해 부모 방에 완료를 주입. 부모 방의 카드 메시지가 상태를 추적.

왜 파일 큐인가: MCP 서버(session-comm)는 **별도 프로세스**라 런타임 메모리에 직접 못 닿는다.
파일 append + `.processing` rename 클레임이 크래시에도 살아남는 가장 단순한 at-least-once다.
(negotium MCP의 send_message는 임베디드 HTTP라 직접 호출할 수도 있지만, 내구성을 위해
같은 큐에 쓴다 — 입구가 하나면 시맨틱도 하나다.)

## 5. MCP 세 층

1. **negotium MCP** (`packages/mcp`) — 런타임 프로세스가 여는 HTTP 엔드포인트.
   턴마다 HMAC 서명 토큰(사용자/토픽/컨텍스트 포함)을 발급해 에이전트가 접속한다.
   **토큰이 곧 인증** — 툴은 토큰의 userId만 믿고, 다른 유저 토픽은 "없는 것"으로 보인다.
   codex는 streamable HTTP(`/mcp`), claude/maestro는 SSE(`/sse`)를 쓴다.
2. **내장 stdio 서버들** (`core/src/mcp/`) — task/wiki/vault/session-comm/health 등.
   턴마다 스폰되는 단명 프로세스. codex만 bun 대신 node+tsx로 띄운다(핸드셰이크 버그 회피).
3. **mcp-host** (`packages/mcp-host`) — 사용자가 노드에 "할당"하는 장수명 MCP들
   (브라우저 등)의 프로세스/포트 관리자. 포트 범위 할당, 포트파일, 헬스체크, idle evict.

## 6. 상태 디렉토리 (`~/.negotium`)

```
workspace/   토픽별 작업 디렉토리, 공유 wiki(skills/summaries/articles/archive), 브라우저 프로필
data/        sessions.db(SQLite WAL — 토픽/메시지/세션 매핑), vault, mcp-manifest.json
run/         휘발성 IPC — session-inbox/(큐), mcp-ports/, progress/
logs/        활동 로그 JSONL (크기 로테이션)
```

- SQLite는 WAL 모드 + busy_timeout. **한 머신에 런타임 프로세스 하나**가 규칙인 이유.
- vault는 AES 암호화, 마스터키는 `data/vault-master-key`(0600) 또는 env.
- 토픽 삭제는 **아카이브가 선행**된다(`topics/lifecycle.ts`): 원문 JSONL을 wiki/archive에
  덤프 → wiki-archiver 에이전트가 요약 → 그 다음에야 행 삭제. force 없이는 히스토리를 안 잃는다.

## 7. 호스트(어댑터) 계약

들어오는 방향 두 줄, 나가는 방향 한 줄:

```ts
appendApiMessage({...});                          // 사용자 메시지 영속
startAiTurn({ topic, userId, prompt, allowAutoContinue: true });
runtimeBus().subscribe(render);                   // 모든 출력은 bus로 온다
```

bus 이벤트 타입: `message`(영속된 메시지), `message-updated`(카드/진행 edit),
`ai-status`(턴 상태·툴콜·에러), `topic-created/updated/deleted`.
**`topic-created`가 중요하다**: spawn_subagent가 만든 방을 채널이 "구체화"(예: 텔레그램
포럼 토픽 생성)하는 신호가 이것이다. 어댑터는 (채널 방 ↔ topicId) 매핑을 자기 영역에 영속한다.

## 8. 의도적으로 뺀 것 (나중 단계)

- **peer/relay** (노드 간 통신): otium의 peer 프로토콜 자리를 비워뒀다.
  `node/topic` 어드레싱 형태는 session-comm에 남아 있고(`peer-forward.ts` 스텁),
  otium 허브 결합 시 "bus 이벤트를 outbound WS로 중계하는 어댑터"로 구현한다.
- **cron**: pm2 결합이 커서 v1 제외.
- **auth/멀티유저 UI**: 코어는 userId 문자열로 격리만 한다. 사용자 관리는 호스트 책임.

## 9. 코드 읽는 순서 (추천)

1. `bus.ts` (120줄) — 호스트 경계 감 잡기
2. `topics/create.ts` → `storage/api-topics.ts` — 토픽 모델
3. `runtime/turn-runner.ts`의 `startAiTurn` — 위 3장의 흐름을 코드로
4. `query/active-rooms.ts` — 방 점유/우선순위/defer 큐
5. `runtime/inbox.ts` — 큐 드레인과 tell/ask 핸들러
6. `agents/claude-provider.ts` — provider 하나만 정독 (나머지 둘은 같은 모양)
7. `packages/mcp/src/node-tools.ts` — 외부에서 노드가 어떻게 보이는가
