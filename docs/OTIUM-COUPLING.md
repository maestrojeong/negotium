# otium 허브 ↔ negotium 워커 노드 결합 계약 (OTIUM-COUPLING)

> 대상 독자: `@negotium/adapter-otium`을 구현할 사람.
> 근거 코드: `~/otium-copy` (otium 모노레포 사본, 2026-07 기준). 모든 경로/타입/헤더 이름은
> 실제 코드에서 그대로 옮겼다. 핵심 파일:
> - `apps/runtime-api/src/peer/{protocol,routes,client,central,turn-dispatch,turn-runner,execution-spec,remote-asks,reply,health}.ts`
> - `apps/runtime-api/src/storage/{topic-nodes,peer-turns,peer-turn-requests,peer-sessions,peer-inbox-requests}.ts`
> - `apps/central-api/src/api/routes/{peer,relay,admin,workspaces}.ts`, `src/service/assignment.ts`, `src/storage/{peer-tokens,runtime-cells,assignments}.ts`
> - `apps/relay/src/*`, `packages/relay-protocol/src/*`, `apps/runtime-api/src/platform/relay-tunnel.ts`

---

## 0. 용어와 등장인물

| 용어 | 뜻 |
|---|---|
| **central-api** | 신원 권위자. 워크스페이스/유저/셀 레지스트리, peer 토큰 발급·검증. 기본 포트 4600 (`CENTRAL_PORT`) |
| **runtime cell** | central에 등록된 runtime 인스턴스 하나. id `cell_…`, 시크릿 `rcs_…`(등록 시 딱 한 번 반환, 해시 저장) |
| **hub (Primary)** | 워크스페이스당 1개인 대표 노드. `workspace_instance_assignments.is_primary = 1`. 사용자 UI/방(topic)의 원본이 여기 산다 |
| **worker node** | 같은 워크스페이스에 추가로 붙는 노드 (`is_primary = 0`, `node_name` 보유). **negotium 노드가 되려는 자리가 이것** |
| **placed room** | hub의 topic 중 `topic_nodes` 행으로 특정 워커에 고정된 방. 턴 실행은 워커에서, 메시지/UI는 hub에서 |
| **hidden mirror topic** | 워커 쪽에서 placed room 하나당 만들어지는 숨은 실행용 로컬 토픽 (`peer_sessions`: `(host_node_id, host_topic_id) → local_topic_id`, id는 `peer-{uuid}`) |
| **peer token** | 노드 간 HTTP 호출용 단명 토큰 `ptk_…`. central이 (workspace, from, to) 스코프로 발급, TTL 300초 (`CENTRAL_PEER_TOKEN_TTL_SECONDS`) |
| **relay** | 아웃바운드 WS 터널 허브. `https://{relay}/n/{cellId}/…` → 터널로 노드에 프록시. 로컬 실험에서는 **불필요** (아래 5장) |

프로토콜 버전: `PEER_PROTOCOL_VERSION = 1` (`peer/protocol.ts`). 모든 peer 요청 바디는 `v`를
포함하고, 수신자는 `typeof v !== "number" || v > PEER_PROTOCOL_VERSION`이면
400 `unsupported peer protocol version (mine: 1)`로 거절한다. 추가 optional 필드는 범프 없이 허용.

모든 peer 응답의 공통 형태: 성공 `{ ok: true, ... }`, 실패 `{ ok: false, error: string }` + HTTP status.

---

## 1. 역할과 전체 흐름

### 1.1 노드 등록·어태치 (오늘의 otium: 운영자 주도)

지금 otium에는 "노드 초대 코드"가 없다. 노드 어태치는 central **운영자(admin)** API로만 된다:

1. `POST {central}/admin/runtime-cells` — body `{ name, baseUrl? }`, 세션 쿠키(central admin 계정,
   `CENTRAL_ADMIN_EMAILS`로 부트스트랩). 응답 `{ ok, cell: {id, baseUrl, …}, secret }` —
   **`secret`(`rcs_…`)은 이때 딱 한 번 노출**된다. `baseUrl` 생략 시
   `{CENTRAL_RELAY_URL}/n/{cellId}`가 자동 부여(릴레이 어태치 셀), 명시하면 직결 URL.
2. `POST {central}/admin/workspace-assignments` — body
   `{ workspaceId, runtimeCellId, worker: true, nodeName }`.
   제약(`service/assignment.ts` `assignWorkspaceToCell`):
   - hub(Primary)가 이미 있어야 함 (`no_hub` 409)
   - 셀 하나는 활성 워크스페이스 1개만 (`cell_full` 409)
   - `nodeName`은 워크스페이스 내 유일 + `normalizeNodeName` 통과 (`node_name_taken`/`node_name_invalid`)
3. 노드 쪽 env: `CENTRAL_API_URL`, `RUNTIME_CELL_ID`, `RUNTIME_CELL_SECRET` **셋 다** 설정
   (하나라도 빠지면 fail-closed, `platform/config.ts` `hostedRuntimeConfig`) +
   `OTIUM_MULTI_NODE=1` (이 플래그 없으면 `multiNodeEnabled() === false`라서 peer 라우트 전체가 403).
4. (릴레이 어태치일 때만) `OTIUM_RELAY_URL` 설정 → 부팅 시 `maybeStartRelayTunnel`이
   `OTIUM_RELAY_TOKEN ?? RUNTIME_CELL_SECRET`을 크리덴셜로 터널을 연다.

참고: runtime-api의 `api/mcp/admin-invite-core.ts`(`create_invite` MCP 도구)는 **노드 초대가 아니라
그 runtime의 사용자 초대 코드**이고, central `POST /workspaces/:id/invites`는 이메일 바운드
**멤버 초대**다. 즉 "워크스페이스가 노드 초대 코드를 발급"하는 UX는 신규 작업이다 → 5장.

### 1.2 디스커버리와 상호 인증 (모든 peer 호출의 전제)

- 노드 목록: `GET {central}/peer/nodes`, 헤더 `authorization: Bearer {RUNTIME_CELL_SECRET}` →
  `{ ok, workspaceId, nodes: PeerNode[] }`,
  `PeerNode = { cellId, nodeName, isPrimary, baseUrl, self }`. 노드 쪽 30초 캐시(`NODES_CACHE_MS`),
  해석 실패 시 `fresh: true`로 1회 재조회.
- 토큰 발급(호출자): `POST {central}/peer/token`, Bearer rcs, body `{ toCellId }` →
  `{ ok, token, expiresAt, workspaceId, toCellId }`. 만료 30초 전까지 재사용 캐시.
  자기 자신 대상은 400, 다른 워크스페이스/비활성 셀은 403.
- 토큰 검증(수신자): `POST {central}/peer/verify`, Bearer **자기** rcs, body `{ token }` →
  `{ ok, workspaceId, fromCellId, fromNodeName, fromIsPrimary, expiresAt }` (= `VerifiedPeer`).
  - central은 `token.to_cell_id === 검증자 cell.id`를 강제(403 "peer token not addressed to this node")
    → 릴레이 오라우팅/재전송 방어.
  - 양쪽 assignment를 **라이브로 재확인** → 노드 해제 시 TTL을 기다리지 않고 수 초 내 차단
    (노드 쪽 positive 캐시 `VERIFY_CACHE_MS = 30초`).
- 노드 간 실제 호출: `fetch("{node.baseUrl}{path}")`, 헤더
  `authorization: Bearer {peerToken}`, `content-type: application/json`.
  타임아웃: 일반 POST 15초(`PEER_REQUEST_TIMEOUT_MS`), GET 5초, 파일 폼 6시간(`FILE_TRANSFER_TIMEOUT_MS`).
  실패는 큐잉하지 않고 그대로 반환한다("unreachable peer must fail visibly").

### 1.3 방 배치 (place topic) — hub 사용자 → hub API → 워커 provision

사용자(방 owner)가 hub의 `PUT /api/v1/topics/:topicId/node` (일반 사용자 JWT 인증, body `{ nodeName }`)를
호출하면 hub는 (`peer/routes.ts` `handleSetTopicNode`):

1. 가드: owner만 / `topic.kind === "agent" && !topic.isSubagent`만 / 이미 네이티브 세션이 있으면
   409 "room already has an active session; create a new room instead" / 턴 진행 중 409 /
   다른 노드로의 이동은 워커 세션 히스토리가 있으면 409.
2. `resolvePlacedTopicExecution(topic)` → `PlacedTopicExecutionSpec`
   `{ agent, model, effort, description?, mcp: string[], canSpawnSubagents }`
   (topic config override > topic default > registry 기본값; **hub가 완결 해석**하고 워커는 재해석 금지).
3. 워커 준비 확인: `GET {worker}/ready` (무인증, 3초 타임아웃, `{ok:true}` 기대) →
   `GET {worker}/api/v1/peer/capabilities` → 요청 agent가 `available`인지, `execution.mcp ⊆ optionalMcp`인지.
4. `POST {worker}/api/v1/peer/provision` — `PeerProvisionRequest`
   `{ v, userId, hostTopicId, topicTitle, execution }` → 워커가 hidden mirror topic 생성/갱신.
5. 성공 시에만 hub가 `topic_nodes`에 `setTopicNode(topicId, cellId, nodeName)` upsert.

조회/해제: `GET /api/v1/topics/:topicId/node` → `{ ok, data: {nodeName, nodeId} | null }`,
`DELETE /api/v1/topics/:topicId/node` (워커 턴 히스토리가 있으면 409 — 로컬 복귀 금지).
노드 피커: `GET /api/v1/peer/workspace-nodes` (사용자 JWT) → readiness 포함 노드 목록.

### 1.4 턴 디스패치 (hub → worker) 와 이벤트 역류 (worker → hub)

사용자가 placed room에 메시지를 보내면 hub는 (`api/routes/ai.ts` L1607-1656 → `peer/turn-dispatch.ts`):

```
hub                                                        worker
────                                                       ──────
requestId = "pt-{uuid}"  (이게 곧 클라이언트 queryId)
GET  /ready, GET /api/v1/peer/capabilities  ── 검사
POST /api/v1/peer/provision                 ── 매 턴 재-provision (idempotent)
POST /api/v1/peer/input-file (첨부별, multipart)          → { ok, fileId }  (워커 로컬 fileId로 치환)
createPeerTurn(requestId, topicId, nodeId)  status=queued
broadcastAiActive + typing "ai"             (즉각 UI 피드백)
POST /api/v1/peer/turn  PeerTurnRequest ────────────────→  claimPeerTurnRequest(hostCellId, requestId)
  { v, requestId, userId, hostTopicId,                       재전송이면 재실행 없이 {ok:true} (replay ack)
    topicTitle, execution, attachments?, message }           provision → 이전 forwarder 있으면 합성
                                            ←── {ok:true}     ai_aborted(reason:"superseded")로 정리
armWatchdog(30분)                                            triggerTopicAiTurn(localTopicId, …,
                                                               origin:"user", requestId, executionSpec,
                                                               peerBridge:{hubCellId,hostTopicId,
                                                                           hostQueryId,canSpawnSubagents})
                                                             WsHub topic tap 등록 → 이하 이벤트 전달
        ←──────────  POST /api/v1/peer/event  (seq=1,2,3,…)  PeerEventRequest {v, requestId, seq, event}
handlePeerTurnEvent: claim→apply→commit
  (2-phase 저널, 아래 3.3)
터미널(ai_done|ai_error|ai_aborted) 수신 시:
  markPeerTurnTerminal, ask 콜백/서브에이전트 정산,
  inject 큐 드레인
```

- **`requestId`가 계약의 축**: hub 클라이언트가 보는 queryId이자, 워커의 idempotency 키이자,
  이벤트 스트림의 상관 키. 워커 내부 queryId는 hub 도착 시 requestId로 **재작성**된다.
- 이벤트 `event`는 otium **`WsServerMessage` 모양의 raw 오브젝트**다
  (`packages/api-types/src/index.ts` L300-395). 워커가 전달해야 하는 타입(워커 측 `FORWARDED_TYPES`):
  `message`, `message_updated`, `typing`, `tool_call`, `tool_output`, `tool_status`,
  `visual`, `file_ready`, `ai_done`, `ai_error`, `ai_aborted`.
- **seq 규칙**: requestId마다 1부터 시작, **연속 필수**. hub는 gap이면 409
  `peer event gap: expected N, received M`, 재전송(동일 seq+동일 event_json)이면 200 replay ack.
  워커는 전송 실패 시 100ms 기저 지수 백오프로 최대 5회 재시도(`PEER_EVENT_MAX_ATTEMPTS`),
  소진되면 **그 뒤 seq를 절대 보내지 않고**(`deliveryBlocked`) hub 워치독(30분)이 턴을 실패 처리하게 둔다.
  "seq N을 잃고 N+1을 보내는 것"이 유일한 금지 사항이다.

### 1.5 tell / ask / abort (세션 간 통신, 양방향)

발신 노드의 에이전트가 session-comm MCP로 `"<nodeName>/<topicTitle>"`(`parsePeerTarget`, 첫 `/`에서 분리)을
지정하면, 그 노드의 runtime이 loopback `POST /api/v1/peer/forward`(Bearer `RUNTIME_MCP_SECRET`,
로컬 MCP 전용)를 거쳐 대상 노드로 아래를 쏜다:

- `POST /api/v1/peer/tell` — `PeerTellRequest { v, requestId, userId, toTopic, fromLabel, message, depth }`.
  수신자: 제목으로 topic 조회(404), `depth > MAX_TELL_DEPTH` 400, 메시지 10,000자 초과 400.
  `peer_inbox_requests`에 `(from_cell_id, request_id, kind)` PK + payload sha256으로 클레임 —
  replay → `{ ok:true, replayed:true }`, 같은 requestId 다른 페이로드 → 409.
  성공 시 세션 인박스 JSONL에 `{type:"tell", requestId, from, fromTitle, message, depth, timestamp}` append.
- `POST /api/v1/peer/ask` — `PeerAskRequest { v, requestId, userId, toTopic, fromLabel, message, fromDepth, replyTo:{topicId} }`.
  대상 topic에 agent가 없으면 409. 인박스 엔트리에 `remoteReply: RemoteReplyRoute
  { nodeName, nodeCellId, topicId, userId, requestId }`가 붙는다.
  **응답 의무**: ask 턴이 끝나면 수신 노드가 발신 노드로
  `POST /api/v1/peer/reply` — `PeerReplyRequest { v, requestId, userId, kind:"reply"|"error", replyText, fromLabel }`.
  발신 노드는 in-memory `remote-asks` 레지스트리(TTL 15분)에서 `takeRemoteAsk(requestId, fromCellId)` —
  **정확히 한 번 소비**, 기대한 cellId가 아니면 드롭, 없으면 404 "no pending ask for this requestId".
  (레지스트리는 메모리라 재시작하면 유실 → 발신자 타임아웃으로 수렴.)
- `POST /api/v1/peer/abort` — `PeerAbortRequest { v, requestId?, userId, toTopic }`.
  - `requestId` 있음(placed-room 턴의 정확 중단): 워커의 `abortHostedPeerTurn` —
    running 상태 + 활성 forwarder의 requestId 일치일 때만 abort, 아니면 404.
    후속 턴을 오폭하지 않기 위한 규칙. fire-and-forget이고 **워커의 `ai_aborted` 이벤트가 권위 터미널**.
  - `requestId` 없음(session-comm의 topic 스코프 중단): 인박스에 `{type:"abort"}` append.
- `POST /api/v1/peer/sessions` — `PeerSessionsRequest { v, userId }` →
  `{ ok, sessions: PeerSessionEntry[] }`, `PeerSessionEntry = { name, agent: string|null, hasSession, description? }`
  (manager/subagent 제외, 해당 userId가 참가자인 topic만).

hub의 placed room으로 들어온 tell/ask도 hub 인박스에서 소비된 뒤 **워커 턴으로 재디스패치**된다
(`query/session-inbox.ts` `handleTellEntry`): requestId를 `pt-tell-{requestId}` 같은 안정 키로 만들어
`dispatchOrQueuePeerInject` — 활성 턴이 있으면 topic별 큐에 대기, 터미널 이벤트에서 하나씩 드레인
(세션 순서 보존; 사용자 턴만 preempt 가능, inject는 항상 대기).

### 1.6 브리지: 워커 턴이 hub의 UI/스토리지를 조작해야 할 때 (worker → hub)

placed 턴 안에서 도구가 hub 쪽 효과를 내야 하면 워커가 hub의 브리지 엔드포인트를 호출한다
(전부 peer 토큰 인증, `hostQueryId`(=requestId)가 queued|running이고 caller cellId 일치 + userId가
host topic 참가자일 때만, 아니면 409):

| 엔드포인트 | 용도 | 요청/응답 |
|---|---|---|
| `POST /api/v1/peer/bridge/file` | 산출 파일 바이트를 hub 업로드 스토어에 저장(+선택적 📎 메시지) | multipart `{hostQueryId, userId, agent, model?, announce, file}` → `{ok, attachment}`; 2GB 초과 413 |
| `POST /api/v1/peer/bridge/ask/start` | ask_user 카드를 hub 방에 개설 | `{hostQueryId, bridgeRequestId, userId, agent, model?, input}` → `{ok, pending:true}`; bridgeRequestId 충돌 409 |
| `POST /api/v1/peer/bridge/ask/result` | 답변 폴링 | `{hostQueryId, bridgeRequestId}` → `{ok, pending}` 또는 `{ok, pending:false, result}` (1회 소비, TTL 35분) |
| `POST /api/v1/peer/bridge/spawn` | spawn_subagent — **자식 방은 hub에 생기고 placement가 이 워커로 고정**됨 | `{hostQueryId, userId, agent, model?, input}` → `{ok, result}` |
| `POST /api/v1/peer/bridge/self-config` | spawn_topic/fork_topic 등 self-config 도구를 hub에서 실행 | `{hostQueryId, userId, tool, input, currentUserPrompt?}` → `{ok, result}`; spawn/fork 턴당 5회 캡 |
| `POST /api/v1/peer/bridge/visual` | 비주얼을 hub topic에 저장하고 hub URL 획득 | `{hostQueryId, userId, kind:"html"\|"mermaid"\|"image"\|"video", title?, html?, code?, theme?, fileId?, mimeType?, source?}` → `{ok, id, url, title}` |
| `POST /api/v1/peer/input-file` | (역방향, hub→worker) 턴 첨부 사전 복사 | multipart `{hostTopicId, userId, file}` → `{ok, fileId}`; provision 안 됐으면 404 |

### 1.7 릴레이 터널 (NAT 뒤 노드일 때만)

- 노드가 `wss://{relay}/tunnel`로 **아웃바운드** WS를 연다. 업그레이드 시
  `authorization: Bearer {rcs_secret}` (또는 `?token=`).
- 릴레이는 시크릿을 그대로 central `POST /relay/verify-cell` (Bearer 전달)로 검증 →
  `{ ok, cell:{id,…} }`의 `cell.id`가 라우팅용 nodeId가 된다 (**노드 자기주장 불가**).
  central 없이는 `RELAY_STATIC_TOKENS="nodeId=token,…"` 폴백.
- 첫 프레임 `{type:"register", protocolVersion: 1, nodeVersion?}` →
  `{type:"registered", nodeId, protocolVersion, pingIntervalMs}` 또는
  `{type:"register_error", code: "upgrade_required"|"unauthorized"|"replaced"}`.
- 이후 JSON 텍스트 프레임 멀티플렉싱 (`packages/relay-protocol/src/protocol.ts`):
  HTTP는 relay→node `http_req_head/chunk/end/abort`, node→relay `http_res_head/chunk/end/error`
  (바디 base64, 청크 최대 256KB `MAX_CHUNK_BYTES`); WS 브리지는 `ws_open/ws_open_ok/ws_data/ws_close`.
  liveness: 릴레이가 `ping`, 노드가 `pong`; 프레임 3 인터벌 무소식이면 양쪽 다 끊고 재접속(지수 백오프 1s→30s).
- 클라이언트는 `https://{relay}/n/{cellId}/{rest}`로 접근, 릴레이가 `/n/:cellId` 프리픽스를 벗겨
  터널로 전달. 노드 끊기면 대기 요청 즉시 502.
- 노드 쪽 구현은 `TunnelClient` (`@otium/relay-protocol`) 하나로 끝난다 — 로컬 runtime을 향한
  순수 리버스 프록시라 runtime 코드 변경이 0이다. **negotium 어댑터도 이 패키지를 그대로 쓰면 된다.**

---

## 2. 워커 노드 표면 — negotium이 구현해야 할 정확한 계약

### 2.1 인바운드 HTTP (워커가 노출)

공통: JSON 바디, 실패 `{ok:false, error}`. "peer 인증" = ① multi-node 활성 아니면 403
"multi-node is disabled" ② Bearer 토큰 없으면 401 "missing peer token" ③ central
`POST /peer/verify` 실패 시 401 "invalid peer token" (positive 캐시 30초 허용) ④ `v` 체크.
"primary 전용" = `verified.fromIsPrimary`가 아니면 403 "only the workspace hub may call this endpoint".

| # | Method Path | 인증 | 필수 |
|---|---|---|---|
| 1 | `GET /ready` | 없음 | **필수**. `{ok:true}` 200. hub가 배치/디스패치 전마다 3초 타임아웃으로 찌른다 (5초 캐시) |
| 2 | `GET /api/v1/peer/capabilities` | peer | **필수**. `{ok, protocolVersion:1, runtimeVersion, agents:[{kind, available, defaultModel, validEfforts, error?}], optionalMcp: string[]}` — hub가 배치·디스패치마다 agent 가용성과 `execution.mcp ⊆ optionalMcp`를 검사 |
| 3 | `GET /api/v1/peer/health` | peer | 권장. `{ok, uptimeSeconds, cpu:{cores, loadAverage}, memory:{totalBytes, freeBytes, processRssBytes, processHeapUsedBytes}, disk?:{totalBytes, freeBytes}}` |
| 4 | `POST /api/v1/peer/provision` | peer+primary | **필수**. `PeerProvisionRequest`. 멱등: `(hostCellId, hostTopicId)`로 hidden topic upsert. agent 미지원 시 400 `unknown agent "…"`. **agent 또는 model이 바뀌면 저장된 provider sessionId를 무효화**해야 함 (`peer-execution-spec-changed`) |
| 5 | `POST /api/v1/peer/turn` | peer+primary | **필수**. `PeerTurnRequest`. 멱등 규칙: `(hostCellId, requestId)` 최초 클레임만 실행. 재전송 — 비-failed 상태면 `{ok:true}`(재실행 금지), failed면 409 + 이전 error, 다른 hostTopicId면 409 "requestId already belongs to another room". 수락은 즉시 `{ok:true}`, 실행은 비동기, 결과는 전부 `/peer/event`로. 새 턴은 같은 방의 진행 중 턴을 **supersede** — 이전 턴에 합성 `ai_aborted(reason:"superseded")` 터미널을 hub로 보낸 뒤 시작 |
| 6 | `POST /api/v1/peer/abort` | peer | **필수**. requestId 있으면 그 턴이 running + 현재 활성 턴일 때만 abort(아니면 404 "turn not found or already completed"); 없으면 topic 스코프 abort. 어느 쪽이든 실제 종료는 `ai_aborted` 이벤트가 증명 |
| 7 | `POST /api/v1/peer/input-file` | peer+primary | 첨부 쓰면 필수. multipart → 로컬 업로드 저장 → `{ok, fileId}`. 이후 `/peer/turn`의 `attachments`에 이 fileId가 온다 |
| 8 | `POST /api/v1/peer/tell` | peer | 권장(hub 에이전트의 `tell_session nodeName/topic`용). 시맨틱은 1.5 그대로 — **durable 멱등 클레임**(`(fromCellId, requestId, kind)`+payload hash) 필수, replay는 `{ok:true, replayed:true}` |
| 9 | `POST /api/v1/peer/ask` | peer | 권장. 인박스 ask + **완료 시 발신 노드로 `/peer/reply` POST 의무** |
| 10 | `POST /api/v1/peer/sessions` | peer | 권장(hub 에이전트의 peek 목록). |
| 11 | `POST /api/v1/peer/reply` | peer | 워커발 크로스노드 ask를 안 쓰면 생략 가능 (404 응답만 해도 계약 위반 아님 — 발신자 타임아웃) |

붙이지 않아도 되는 것: `/api/v1/peer/forward`, `/api/v1/peer/nodes`, `/api/v1/peer/node-check`
(loopback MCP 편의 API), `/api/v1/peer/workspace-nodes`, `/api/v1/topics/:id/node`(hub 전용),
`/api/v1/peer/event`, `/api/v1/peer/bridge/*`(hub이 노출하는 쪽).

### 2.2 아웃바운드 의무 (워커가 호출)

1. **central**: `GET /peer/nodes`(hub baseUrl 해석), `POST /peer/token`(hub 대상 토큰 발급),
   `POST /peer/verify`(인바운드 검증). 전부 `Bearer RUNTIME_CELL_SECRET`, 타임아웃 5초.
2. **hub 이벤트**: `POST {hub.baseUrl}/api/v1/peer/event`, `PeerEventRequest {v, requestId, seq, event}`.
   - seq: 턴마다 1부터 연속, 전송은 **체인 직렬화**(이전 전송 완료 후 다음).
   - event 페이로드는 otium `WsServerMessage` 모양 (필드까지 정확히):
     - `{type:"message", topicId, message: MessageDto}` — hub는 `message.authorId === "ai"`만
       정식 채택(id 유지, `queryId`←requestId로 재작성) + `authorId==="system" && id.startsWith("tasks-")`
       태스크 패널만 예외 채택(`tasks-{requestId}`로 id 재작성). 나머지 authorId는 버린다.
       **최종 답변 텍스트는 이 message 이벤트가 유일한 전달 경로다** (ai_done엔 텍스트가 없다).
     - `{type:"message_updated", topicId, messageId, text?, editedAt?}` — `tasks-` 프리픽스만 반영.
     - `{type:"typing", topicId, userId}` (`"ai"` 또는 클리어용 `""`).
     - `{type:"tool_call", topicId, queryId, name, input?, label, toolUseId}` /
       `{type:"tool_output", topicId, queryId, toolUseId, content}` /
       `{type:"tool_status", topicId, queryId, kind:"status"|"progress"|"summary", content, toolName?, elapsed?}` /
       `{type:"file_ready", topicId, queryId, path, source}` /
       `{type:"visual", topicId, queryId, url, id?, title?, kind?}` — hub가 topicId/queryId만
       재작성해 그대로 재방송(`REBROADCAST_TYPES`).
     - 터미널 정확히 1개: `{type:"ai_done", queryId, topicId, usage?, agent?, model?}` |
       `{type:"ai_error", queryId, topicId, error}` | `{type:"ai_aborted", queryId, topicId, reason?}`.
   - 재시도/차단 규칙은 1.4. hub 응답 코드: 404(모르는 requestId — hub 재시작으로 상태 소실),
     403(다른 노드 소행), 409(gap), 500(적용 실패 — 같은 seq 재전송하면 됨).
3. **ask 응답**: 인바운드 ask 완료 시 발신 노드 `POST /api/v1/peer/reply` (1.5).
4. **브리지**(선택): 1.6의 hub 엔드포인트들.
5. **릴레이**(NAT 뒤일 때): `TunnelClient` 상시 유지 (1.7).

### 2.3 워커가 지켜야 할 불변식 요약

- **at-least-once 입력, exactly-once 실행**: `/peer/turn`·`/peer/tell`·`/peer/ask`는 전부 재전송될 수 있다.
  requestId 클레임은 **재시작에도 살아남는 durable 저장**이어야 한다 (otium은 SQLite
  `peer_turn_requests`, `peer_inbox_requests`; 워커 재시작 시 claimed/running을 일괄 failed 처리 —
  `failInterruptedPeerTurnRequestsOnApiStartup`).
- **이벤트는 순서 보존 + 갭 금지**. 잃어버리면 멈추는 게 맞다(hub 워치독이 수습).
- **hub 스펙이 진실**: `execution`(agent/model/effort/mcp/canSpawnSubagents)은 매 턴 hub가
  보내는 값으로 실행. 워커 로컬 설정으로 덮어쓰지 않는다.
- **터미널은 정확히 1번**: 정상 종료, 에러, abort, supersede 어느 경로든 requestId당
  터미널 이벤트 하나. supersede 시 이전 턴 몫의 합성 `ai_aborted`를 잊지 말 것.
- 메시지 길이 캡 10,000자(`MAX_PEER_MESSAGE_LENGTH`), tell depth 캡(`MAX_TELL_DEPTH`).

---

## 3. hub 쪽 동작 (어댑터가 기대해도 되는 것)

### 3.1 저장

- `topic_nodes(topic_id PK, node_id, node_name, created_at)` — 행이 없으면 그 방은 로컬 실행.
- `peer_turns(request_id PK, topic_id, node_id, status: queued|running|completed|failed|aborted, last_event_seq, …)` +
  `peer_turn_events(request_id, seq, event_json, status: pending|applied)` — 이벤트 저널.
- `peer_inbox_requests` — 인바운드 tell/ask 멱등 클레임.
- hub API 프로세스 재시작 시 `failInterruptedPeerTurnsOnApiStartup()` — queued/running 전부 failed.
  **즉 hub가 재시작하면 진행 중이던 워커 턴의 이벤트는 404를 받는다. 워커는 그냥 전송을 멈추면 된다.**

### 3.2 언제 워커를 부르나

- 배치 시: `/ready` → `/capabilities` → `/provision` (1.3).
- 사용자 메시지마다: `/ready`(fresh) → `/capabilities` → `/provision` → 첨부별 `/input-file` → `/turn`.
- 다른 토픽발 tell/ask inject: 같은 경로지만 `dispatchOrQueuePeerInject`로 **한 번에 하나만**,
  활성 턴 뒤에 큐잉. 실패는 조용히(호출자 콜백) 처리.
- 사용자 중지: `/abort` (requestId 지정). 응답과 무관하게 워커의 `ai_aborted`가 올 때까지 턴은 활성.
- 헬스: UI 노드 피커가 열릴 때마다 `/ready`(5초 캐시), node-check 시 `/capabilities`+`/health`.
  주기적 하트비트 데몬은 **없다** — 전부 요청 시점 프로브다.

### 3.3 이벤트 → 메시지 브리지의 정확한 순서

`handlePeerTurnEvent` (hub):
1. `getPeerTurn(requestId)` 없으면 404; `turn.node_id !== fromCellId`면 403; `seq` 비정수/≤0이면 400.
2. `claimPeerTurnEvent`: 이미 같은 (requestId,seq)이 applied면 replay(200), pending이면 재적용 시도,
   `seq !== last_event_seq+1`이면 409 gap. 저널 insert(pending).
3. `applyPeerTurnEvent` (1.4/2.2의 채택 규칙). 실패하면 500 — 커서 안 움직였으므로 워커 재전송이 재적용.
4. `commitPeerTurnEvent`: 트랜잭션으로 커서 전진 + 저널 applied. 이후 워치독 재장전(30분).

터미널 처리 시 hub는: `markPeerTurnTerminal`(1회), ask_user 카드 취소, ask 콜백 정산
(`peerFinalText` — 마지막 ai message 텍스트를 답으로 사용; 없으면
"(processed with no text response)"), spawn_subagent 워치 정산, inject 큐 드레인.
`silent` 턴(ask_session용)은 방에 아무것도 안 그리고 콜백만 정산한다.

---

## 4. negotium 매핑 — 의무별 커버리지와 갭

어댑터 형태: **negotium 노드 프로세스가 임베드하는 호스트 모듈** (`@negotium/adapter-otium`).
Bun.serve에 2.1의 라우트를 마운트하고, `runtimeBus().subscribe`로 2.2의 이벤트를 밀어낸다.
negotium 코어는 건드릴 필요가 거의 없다 — ARCHITECTURE.ko.md 8장이 비워둔 자리 그대로.

| 워커 의무 | 기존 negotium API (`@negotium/core` barrel) | 상태 |
|---|---|---|
| `/ready`, `/health`, `/capabilities` | `checkAgentAuth(kind)`, `getRegistry(kind)` (defaultModel/validEfforts), `SUPPORTED_AGENTS` | ✅ 거의 그대로. `optionalMcp`는 negotium mcp-manifest 이름을 노출하면 됨 — 단 hub가 아는 otium MCP 이름과 **이름 체계가 다르면 배치가 409**로 막힘 (갭 G6) |
| provision → hidden topic | `upsertTopic`, `setApiTopicConfig`, `getTopicSessionId`/`setTopicSessionId`, `getTopic` | ✅ 함수는 전부 공개. ❌ `(hostCellId, hostTopicId) → localTopicId` 매핑 테이블(otium `peer_sessions`)은 어댑터가 자체 소유해야 (G1) |
| turn 실행 | `triggerTopicAiTurn(topicId, userId, prompt, agent, opts)` — `origin`(“user” 전달 시 preempt), `requestId`, `injectAuthorId`, `attachments`, `onDispatched`, `modelOverride`, `effortOverride`, 독립 `sessionName/sessionId`, `onSettled` 지원 | ✅ agent/model/effort와 독립 세션은 턴 단위로 전달 가능. ❌ MCP whitelist까지 포함한 완전한 `executionSpec` 파라미터는 없음 (G2). ❌ `peerBridge` 컨텍스트 없음 — negotium MCP는 ask_user/spawn/self-config/visual을 **로컬에서** 실행 (G3) |
| turn 멱등 저널 | 없음 (negotium의 requestId dedup은 인박스 큐 스코프) | ❌ 어댑터가 durable `peer_turn_requests` 동등물 소유 (G1) |
| 이벤트 역류 | `runtimeBus().subscribe` — `message`/`message-updated`/`ai-status` 이벤트; `ai-status` 페이로드가 `{kind: "ai_active"\|"ai_done"\|"ai_error"\|"ai_aborted"\|"tool_call"\|"tool_output"\|"tool_status"\|"file_ready"\|"visual"\|"typing", queryId, …}` | ✅ 정보는 전부 흐른다 (`bus.ts` 주석: “otium WsHub feed를 재구성할 수 있게” 설계됨). 어댑터가 할 일: topicId 필터(local hidden topic) + queryId 필터(supersede 구분) + **`kind`→`type` 개명 및 WsServerMessage 모양 복원** + seq 부여 + 재시도/차단 큐. otium 워커의 `turn-runner.ts` `createForwarder`를 bus 위에 이식하는 것과 같다 |
| abort (정확 requestId) | `abortRoom(topicId)`, `getRoomQuery(topicId)` | ✅ `getRoomQuery`로 활성 queryId를 확인해 “현재 턴 == 그 requestId의 턴”일 때만 `abortRoom` 호출하면 계약 충족 |
| tell 인바운드 | `sessionInboxPath(userId, topicId)` + `appendJsonlEntry` + `flushSessionInbox` — 인박스 엔트리 `{type:"tell", from, fromTitle?, message, depth, requestId?, timestamp}` 모양 동일 | ✅ 그대로 사용 가능. ❌ durable 멱등 클레임(`peer_inbox_requests` 동등물)은 어댑터 소유 (G1) |
| ask 인바운드 + 원격 reply | 인박스 ask 엔트리에 **`remoteReply` 필드가 없다** (`runtime/inbox.ts` L33-56) — negotium ask는 로컬 caller topic에만 회신 | ❌ G4: (a) 코어 인박스에 `remoteReply` 지원을 추가하거나, (b) 어댑터가 ask를 인박스에 안 넣고 `forkAgentSession` + `triggerTopicAiTurn(silent, onDispatched→registerAskCallback)`으로 직접 돌려 완료 텍스트를 hub `/peer/reply`로 POST |
| 첨부 (`/input-file` → `attachments`) | `setFileHooks(FileHooks)` — 기본은 noop(모든 조회 miss) | ❌ G5: 어댑터가 `~/.negotium` 하위 업로드 스토어 + FileHooks 구현을 설치해야 첨부/미디어 비주얼이 동작 |
| central 인증/디스커버리, peer 토큰 mint/verify | 없음 | ❌ 어댑터 신규 (otium `peer/central.ts` 148줄 포팅이면 충분 — 캐시 정책까지 동일하게) |
| 릴레이 터널 | 없음 | ❌ `@otium/relay-protocol`의 `TunnelClient` 재사용 (의존 추가 또는 파일 복사, 436줄). 직결 URL 실험에서는 불필요 |
| session-comm 발신 (`negotium → 다른 노드`) | `mcp/session-comm/peer-forward.ts`가 **의도적 스텁** (“standalone mode” 에러 반환) | ⭕ 선택: 어댑터가 `forwardToPeer`/`peerSessionsForUser`를 실구현으로 교체하면 워커발 tell/ask도 열린다 |

**갭 목록 (우선순위순)**
- **G1** 어댑터 소유 durable 상태: `peer_sessions`·`peer_turn_requests`·`peer_inbox_requests` 동등물
  (SQLite 하나면 충분; 워커 재시작 시 running→failed 일괄 처리 포함).
- **G2** `triggerTopicAiTurn`의 `agent` + `modelOverride` + `effortOverride`로 실행 사양 대부분은
  턴 단위 전달 가능하다. 남은 갭은 MCP whitelist override다. agent/model 변경 시 독립 peer sessionId를
  어댑터가 무효화해야 한다 (`sessionName`, `sessionId`, `onSessionId`로 topic 주 세션과 분리 가능).
- **G3** peerBridge 부재: v0에서는 ask_user/spawn/self-config가 **워커 로컬**에서 동작
  (hub UI에 카드가 안 뜨고, spawn된 방이 hub에 안 생김). placed-room 데모에는 지장 없음.
  v1에서 negotium MCP 도구 정의를 어댑터가 브리지 구현으로 스왑하는 seam이 필요.
- **G4** 원격 ask 회신 경로 (위 표).
- **G5** FileHooks/업로드 스토어.
- **G6** `optionalMcp` 이름 체계 정합 (hub의 `OPTIONAL_FORUM_MCP_SERVERS` vs negotium manifest).
- **G7** visual/file_ready 이벤트의 URL/경로가 워커 로컬을 가리킴 — 브리지(G3) 없이는 hub UI에서
  클릭해도 못 연다. v0에서는 "표시만 되는" 수준으로 수용.

---

## 5. 로컬 실험 계획 — "초대 코드로 negotium 노드 붙이기" (클라우드 없음, 머신 1대)

### 5.0 목표 UX

```
(hub 쪽)  otium 워크스페이스가 노드 초대 코드를 발급
(worker)  $ negotium join <code>
          → 노드가 워크스페이스에 worker로 어태치, hub UI 노드 피커에 나타남
(hub 쪽)  방을 노드에 배치 → 메시지 → 턴이 negotium에서 돌고 이벤트가 hub UI로
```

오늘의 otium에는 노드 초대 코드가 없으므로(1.1), 두 단계로 나눈다:
**v0 = otium-copy 무수정** (코드는 셸 스크립트가 central admin API로 만들어낸 크리덴셜 번들),
**v1 = central-api에 진짜 one-time 노드 초대 엔드포인트 추가** (작은 정직한 변경).

### 5.1 무엇을 띄우나 / 무엇을 생략하나

| 서비스 | 필요? | 이유 |
|---|---|---|
| `apps/central-api` (포트 4600) | **필요** | peer 토큰 mint/verify와 노드 디스커버리는 우회 불가 — 워커 인증의 근간 |
| `apps/runtime-api` = hub (포트 4000) | **필요** | placed room의 주인 |
| `apps/relay` | **불필요** | `registerCell`이 `baseUrl`을 받으므로(admin.ts L280-285) 셀을 **직결 URL**(`http://127.0.0.1:{port}`)로 등록하면 hub↔worker가 relay 없이 직접 통신한다. `PEER_NODE_DIRECT_URL` 같은 otium-copy 변경이 **필요 없다** — baseUrl이 이미 그 역할이다 |
| 이메일/SMS | **불필요** | central은 비프로덕션에서 `EMAIL_MODE=dev`(코드 로그 출력)로 동작 |
| negotium 노드 + adapter-otium (포트 7777) | **필요** | 실험 대상 |

### 5.2 env / 시크릿

```bash
# central-api
CENTRAL_PORT=4600
CENTRAL_STATE_DIR=/tmp/otium-central          # 새 DB
CENTRAL_ADMIN_EMAILS=yeonwoo.jeong@bluehole.net   # 이 메일로 가입하면 central admin
# (비프로덕션: EMAIL_MODE=dev — 로그인 코드가 로그로 나옴)

# hub runtime-api
PORT=4000
CENTRAL_API_URL=http://127.0.0.1:4600
RUNTIME_CELL_ID=<hub cell id>                 # 아래 스크립트가 발급
RUNTIME_CELL_SECRET=<hub rcs_…>
OTIUM_MULTI_NODE=1                            # 없으면 peer 전부 403
OTIUM_ALLOW_LOCAL_AUTH_IN_HOSTED=1            # hosted 모드에서도 로컬 로그인 유지(실험 편의)
JWT_SECRET=dev-anything

# negotium worker (adapter가 읽음 — negotium join이 ~/.negotium/otium.json에 저장하는 값과 동일)
OTIUM_CENTRAL_URL=http://127.0.0.1:4600
OTIUM_CELL_ID=<worker cell id>
OTIUM_CELL_SECRET=<worker rcs_…>
NEGOTIUM_PORT=7777
```

### 5.3 v0: 초대 코드 = admin API 산출물의 캡슐화 (otium-copy 변경 0)

`hub-node-invite.sh` (central admin 세션 쿠키 보유 상태에서):

```bash
# 1) 워커 셀 등록 — 직결 URL
resp=$(curl -sb "$COOKIE" http://127.0.0.1:4600/admin/runtime-cells \
  -H 'content-type: application/json' \
  -d '{"name":"nego-worker","baseUrl":"http://127.0.0.1:7777"}')
CELL_ID=$(jq -r .cell.id <<<"$resp"); SECRET=$(jq -r .secret <<<"$resp")

# 2) worker assignment (hub가 이미 primary로 붙어 있어야 함)
curl -sb "$COOKIE" http://127.0.0.1:4600/admin/workspace-assignments \
  -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"runtimeCellId\":\"$CELL_ID\",\"worker\":true,\"nodeName\":\"nego\"}"

# 3) 초대 코드 = base64url(JSON)
CODE=$(jq -nc --arg c "$CELL_ID" --arg s "$SECRET" \
  '{v:1, central:"http://127.0.0.1:4600", cellId:$c, secret:$s}' | basenc --base64url -w0)
echo "negotium join $CODE"
```

`negotium join <code>` (어댑터 CLI):
1. base64url 디코드 → `{central, cellId, secret}`을 `~/.negotium/otium.json`(0600)에 저장.
2. `GET {central}/peer/nodes` (Bearer secret)로 self 확인 — `self:true` 행의 `nodeName` 출력
   ("attached to workspace … as nego").
3. 노드 기동: Bun.serve(7777)에 ① negotium MCP 핸들러 ② 2.1의 peer 라우트 ③ `/ready`를 마운트,
   `startSessionInboxWorker()` + `runtimeBus().subscribe(forwarder)` 시작.

### 5.4 데모 시나리오 (엔드투엔드 체크리스트)

1. central 기동 → admin 가입/로그인(코드는 로그에서) → 워크스페이스 생성.
2. hub 셀 등록(`baseUrl: http://127.0.0.1:4000`) → `POST /admin/workspace-assignments`
   (worker 없이 = primary) → hub runtime-api 기동(위 env) → 워크스페이스 로그인 확인.
3. `hub-node-invite.sh` → 코드 출력 → `negotium join <code>` → 워커 기동.
4. hub에서 `GET /api/v1/peer/workspace-nodes` → `nego`가 `ready:true`로 보이는지.
5. agent 방 생성(세션 시작 전!) → `PUT /api/v1/topics/{id}/node {"nodeName":"nego"}` →
   200이면 provision까지 성공한 것.
6. 방에 메시지 → hub 로그 `peer-turn: dispatched` → 워커에서 턴 실행 →
   hub UI에 typing/tool_call/최종 ai message 표시 → `peer_turns.status = completed`.
7. 진행 중 중지 버튼 → 워커 abort → `ai_aborted` 역류 확인.
8. (선택) 다른 방에서 `tell_session nego/<방제목>` → 워커 인박스 경유 턴 확인.

### 5.5 v1: 진짜 초대 코드 (otium-copy 최소 변경 — 이 태스크에서는 설계만)

운영자(central admin)가 아니라 **워크스페이스 admin**이 발급하는 one-time 코드가 목표 UX다.
central-api에 라우트 2개면 된다 (기존 `createInvite`/`peer-tokens` 패턴 재사용):

- `POST /workspaces/:id/node-invites` (세션, `requireWorkspaceAdmin`) →
  `{ ok, code: "nvt_…", expiresAt }` — 해시 저장, TTL ~1시간, 1회용.
- `POST /node-invites/claim` (무세션 — 코드 자체가 capability) —
  body `{ code, nodeName, baseUrl? }` → 내부적으로 `registerCell` + `assignWorkspaceToCell(worker:true)`
  → `{ ok, cellId, secret, centralApiUrl, relayUrl, workspaceId, nodeName }`.
  `negotium join`은 이 응답을 저장하면 끝 — v0과 저장 포맷이 같아서 CLI는 안 바뀐다.

### 5.6 relay까지 포함한 확장 실험 (선택)

`apps/relay`를 `RELAY_PORT=4700 RELAY_CENTRAL_API_URL=http://127.0.0.1:4600`으로 띄우고,
워커 셀을 `baseUrl` 없이 등록(→ `{CENTRAL_RELAY_URL}/n/{cellId}`; central에
`CENTRAL_RELAY_URL=http://127.0.0.1:4700` 필요). 어댑터는 `TunnelClient({relayUrl, token: secret,
targetOrigin: "http://127.0.0.1:7777"})`를 켠다. NAT 시나리오 검증용이며 계약 자체는 동일.

---

## 6. 리스크 / 미지수

1. **이벤트 페이로드가 스키마 검증 없는 내부 타입** — `event`는 `WsServerMessage`를 shape-check 없이
   신뢰한다(모노레포 내부 가정). negotium이 필드 하나만 틀려도(`kind` vs `type`, `toolUseId` 누락 등)
   hub가 조용히 버리거나 오작동한다. 어댑터에 otium 쪽 스냅샷 기반 **직렬화 골든 테스트** 필수.
   `PEER_PROTOCOL_VERSION` 범프 시 이 모양이 통째로 바뀔 수 있는 게 최대 버전 결합 지점.
2. **hub 재시작 = 진행 중 턴 전멸** (`failInterruptedPeerTurnsOnApiStartup`). 워커는 404를 받으면
   전송 중단 + 로컬 턴 abort 처리하는 게 깔끔하다(otium 워커는 그냥 전송만 멈춘다).
3. **remote-asks가 in-memory** — 발신 노드 재시작 시 reply가 404로 유실, 타임아웃 수렴. 사양이다.
4. **capabilities의 `optionalMcp` 이름 결합 (G6)** — 이름이 안 맞으면 배치가 409
   `node "…" lacks MCP: …`로 막힌다. 데모에서는 방의 MCP override를 비워서 회피 가능.
5. **`runtimeVersion: "0.1.0"` 하드코딩** — hub가 아직 안 보지만, 향후 호환성 게이트로 쓸 수 있음.
6. **peer verify가 요청마다 central 왕복(30초 캐시)** — central이 죽으면 워커 인바운드 전부 401.
   로컬 실험에서 central을 내리면 즉시 재현된다. 사양(fail-closed)이다.
7. **placed room 제약**: 네이티브 세션이 이미 있는 방은 배치 불가, 워커 히스토리가 생긴 방은
   이동/해제 불가. 데모 순서(방 만들자마자 배치)를 지켜야 한다.
8. **hidden topic의 `isSubagent: true`** — negotium에서 subagent 마킹이 MCP 화이트리스트 비상속 등
   부수 효과를 가지므로, provision 구현 시 otium 의미(“숨김 + canSpawnSubagents는 spec으로 별도 전달”)와
   negotium 의미가 어긋나는지 확인 필요.
9. **bridge 부재(G3)의 사용자 체감** — placed 방에서 에이전트가 ask_user를 부르면 v0에서는 hub에
   카드가 안 뜬다. 데모 프롬프트에서 ask_user 유도를 피하거나, 어댑터가 ask_user 도구를
   `bridge/ask/start`+`result` 폴링 구현으로 스왑하는 걸 v1 최우선으로.
10. **미확인 영역**: hub WsHub의 topic tap(`registerTopicTap`/`removeTopicTap`)과 otium 클라이언트 UI가
    peer 이벤트를 어떻게 렌더하는지는 코드로만 확인했고 실행 검증 전이다. 5.4 체크리스트가 그 검증이다.
