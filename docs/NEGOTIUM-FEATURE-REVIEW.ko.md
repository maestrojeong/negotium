# Negotium 기능별 리뷰 가이드

> 목적: `~/clawgram`, `~/otium/apps/runtime-api`와 비교하면서 Negotium을 **기능 하나씩**
> 검토하기 위한 작업 문서다. 배포 점검표가 아니라 코드 경계, 동작 의미론, 누락과 의도된 차이를
> 판정하는 데 사용한다.

Negotium 자체 원리는 `ARCHITECTURE.ko.md`, 제품 경계는 `PRODUCT-TOPOLOGY.ko.md`, Otium wire 계약은
`OTIUM-COUPLING.md`를 먼저 참고한다.

## 1. 리뷰 방식

각 기능은 “기존 코드와 줄 단위로 같은가”가 아니라 아래 네 종류 중 무엇인지 판정한다.

| 판정 | 의미 | 후속 조치 |
|---|---|---|
| 유지 | 기존 의미론을 Negotium이 그대로 보존 | 회귀 test로 고정 |
| 의도된 차이 | channel/product 결합을 제거하기 위해 구조가 달라짐 | 차이와 owner를 문서화 |
| 기능 gap | 필요한 동작이 아직 없거나 host까지 연결되지 않음 | 우선순위와 acceptance criteria 지정 |
| 범위 밖 | Clawgram/Otium 제품 기능이며 core 책임이 아님 | adapter/module/제품 저장소에 남김 |

한 기능을 리뷰할 때 다음 순서를 고정한다.

1. **권위** — 어떤 프로세스와 저장소가 원본인가?
2. **입력** — user, inject, cron, peer 입력이 같은 실행 경계로 들어오는가?
3. **동시성** — 실행 중 새 입력, 중단, queue 순서가 어떻게 되는가?
4. **영속성** — 성공 응답 전에 무엇이 저장되며 재시작 후 어떻게 복구되는가?
5. **출력** — 최종 message, tool, file, visual, terminal event가 host까지 도착하는가?
6. **보안** — user/topic/file/secret 경계를 누가 검증하는가?
7. **수명주기** — start/stop 실패와 중복 호출이 안전한가?
8. **검증** — unit test뿐 아니라 host 경계를 지나는 scenario가 있는가?

각 장의 마지막 판정란은 리뷰하면서 갱신한다.

```text
판정: [ ] 유지  [ ] 의도된 차이  [ ] 기능 gap  [ ] 범위 밖
결론:
후속 작업:
```

## 2. 권장 리뷰 순서

앞 기능이 뒤 기능의 전제가 되므로 아래 순서가 좋다.

| 순서 | 기능 | 주 비교 대상 | 위험도 | 상태 |
|---:|---|---|---|---|
| 1 | Topic·message·상태 권위 | Clawgram storage, Otium API storage | 높음 | 미검토 |
| 2 | Turn lifecycle·선점·queue | 세 코드의 query/turn runner | 매우 높음 | 미검토 |
| 3 | RuntimeBus·event delivery | Telegram renderer, Otium WsHub | 매우 높음 | 미검토 |
| 4 | Claude/Codex/Maestro provider | 세 코드의 agents | 매우 높음 | 미검토 |
| 5 | Session resume·agent switch·rollout | conversations/rollout | 매우 높음 | 미검토 |
| 6 | tell·ask·spawn collaboration | session-comm/inbox | 높음 | 미검토 |
| 7 | ask_user·self-config·task·visual | Otium runtime tools | 높음 | 미검토 |
| 8 | Wiki·skills·vault·보안 경계 | Clawgram/Otium MCP와 storage | 높음 | 미검토 |
| 9 | MCP server·catalog·mcp-host | 세 코드의 MCP config | 높음 | 미검토 |
| 10 | 파일·첨부·음성·영상·OCR | Clawgram Telegram, Otium files | 높음 | 미검토 |
| 11 | Node lifecycle·module·plugin | Negotium 고유 구조 | 높음 | 미검토 |
| 12 | Cron module | Clawgram/Otium pm2 Cron | 높음 | 미검토 |
| 13 | Terminal adapter | Negotium 고유 host | 중간 | 미검토 |
| 14 | Telegram adapter | Clawgram | 매우 높음 | 미검토 |
| 15 | Otium worker adapter | Otium peer worker | 매우 높음 | 미검토 |
| 16 | private/shared topic 접근과 Otium binding | Negotium 고유 확장 | 매우 높음 | 부분 구현 |
| 17 | CLI·여러 adapter 조합 | 기존 단일 host startup | 중간 | 미검토 |
| 18 | 종료·복구·관측성 | 세 코드 운영 경로 | 높음 | 미검토 |

## 3. Core 리뷰

### 3.1 Topic, message, 상태 권위

**Negotium 코드**

- `packages/core/src/storage/api-topics.ts`
- `packages/core/src/storage/api-messages.ts`
- `packages/core/src/storage/api-topic-config.ts`
- `packages/core/src/topics/{create,derive,lifecycle,links}.ts`
- `packages/core/src/workspace/*`

**기존 구현과 차이**

| 기준 | 차이 |
|---|---|
| Clawgram | Telegram forum group/thread 매핑과 topic row가 가깝게 결합된다. Negotium topic은 channel ID를 모르며 adapter가 매핑을 소유한다. |
| Otium runtime-api | DTO와 `api_*` storage 형태가 가깝지만, Otium은 hub membership/auth/message가 원본이다. Negotium은 한 로컬 node의 상태만 원본이다. |
| Negotium 의도 | core는 `userId` 문자열로 participant를 격리하되 사용자 신원 발급·workspace membership은 관리하지 않는다. |

**리뷰 체크**

- [ ] topic ID와 channel/thread ID가 core schema에서 분리돼 있다.
- [ ] 모든 topic 조회·수정 경로가 participant/user scope를 일관되게 적용한다.
- [ ] manager/subagent/hidden topic이 일반 picker와 API에 실수로 노출되지 않는다.
- [ ] topic 삭제는 archive 성공 후 진행되고 실패 시 원문을 보존한다.
- [ ] topic 이름 변경 후 adapter mapping과 session-comm name resolution이 깨지지 않는다.
- [ ] message 저장과 bus broadcast 순서가 재연결/중복 전송에 안전하다.
- [ ] Otium DTO 편의를 core 권위 모델로 오해해 role/workspace logic을 넣지 않는다.

**관련 test**

- `packages/core/tests/storage/api-topics.test.ts`
- `packages/core/tests/storage/forum-schema-migration.test.ts`
- `packages/core/tests/core/topic-lifecycle-delete.test.ts`
- `packages/core/tests/core/topics/derive.test.ts`

### 3.2 Turn lifecycle, 선점, queue

**Negotium 코드**

- `packages/core/src/runtime/turn-runner.ts`
- `packages/core/src/query/active-rooms.ts`
- `packages/core/src/query/control.ts`
- `packages/core/src/query/state.ts`
- `packages/core/src/runtime/inbox.ts`

**기존 구현과 차이**

- Clawgram은 query runner 안에서 Telegram 전송까지 처리한다.
- Otium은 turn runner 안에서 DB message와 WebSocket/peer bridge까지 처리한다.
- Negotium은 같은 실행 의미론을 유지하되 host 효과를 `RuntimeBus`와 hook으로 밀어냈다.
- 방당 turn 1개, 새 user turn의 선점, inject 대기는 세 코드가 공유해야 하는 핵심 불변식이다.

**리뷰 체크**

- [ ] user 입력만 active turn을 선점하고 tell/cron/background inject는 대기한다.
- [ ] abort가 정확히 현재 query만 종료하며 뒤에 시작된 turn을 오폭하지 않는다.
- [ ] abort/error/done terminal event가 turn마다 정확히 하나다.
- [ ] turn 종료의 모든 경로에서 room lock을 해제하고 deferred inject 하나를 drain한다.
- [ ] provider 시작 전 실패와 stream 중 실패가 같은 cleanup 경로로 수렴한다.
- [ ] requestId replay가 새 provider turn을 만들지 않는다.
- [ ] silent ask/cron/peer turn이 사용자 message를 잘못 저장하거나 브로드캐스트하지 않는다.
- [ ] auto-continue가 user 우선순위와 최대 반복 제한을 우회하지 않는다.

**관련 test**

- `packages/core/tests/query/{active-rooms,inter-session-queue,smoke,stress}.test.ts`

### 3.3 RuntimeBus와 최종 event delivery

**Negotium 코드**

- `packages/core/src/bus.ts`
- `packages/core/src/types/api.ts`
- `packages/core/src/runtime/turn-runner.ts`

**기존 구현과 차이**

| 기준 | 최종 소비자 |
|---|---|
| Clawgram | Telegram send/edit/photo/document 호출 |
| Otium runtime-api | DB `message` + WebSocket `WsServerMessage` |
| Negotium | in-process `RuntimeBusEvent`; adapter가 실제 전달 책임 |

`ai_done`은 final text를 대체하지 않는다. message event가 누락되면 terminal은 성공이어도 사용자는
답을 받지 못한다.

**리뷰 체크**

- [ ] message를 영속한 뒤 bus에 내보내며 observer가 저장 권위를 바꾸지 않는다.
- [ ] subscriber 하나의 예외가 다른 subscriber와 turn을 깨지 않는다.
- [ ] message/message-updated/topic lifecycle/ai-status event에 stable payload가 있다.
- [ ] tool_call과 tool_output의 `toolUseId`가 항상 연결된다.
- [ ] final message 후 terminal event 순서가 adapter마다 동일하다.
- [ ] file/visual/task/ask_user/subagent event를 지원하지 않는 adapter가 명시적 fallback을 갖는다.
- [ ] bus는 replay log가 아님을 명시하고, 재연결 host는 storage를 다시 읽는다.

**관련 test**

- core의 turn tests와 각 adapter의 state/contract test를 함께 본다.

### 3.4 Claude, Codex, Maestro provider

**Negotium 코드**

- `packages/core/src/agents/{claude,codex,maestro}-provider.ts`
- `packages/core/src/agents/{claude,codex,maestro}-registry.ts`
- `packages/core/src/agents/contracts.ts`
- `packages/core/src/agents/tool-format.ts`
- `packages/core/src/agents/codex-tree-kill.ts`

**현재 차이**

- Clawgram, runtime-api, Negotium에 아직 provider 구현이 각각 남아 있다.
- SDK 버전도 다르다. 특히 Otium은 Maestro `0.1.42`, Negotium/Clawgram은 `0.1.44`다.
- Negotium provider는 Telegram/WS를 모르고 `UnifiedEvent`만 생성해야 한다.
- provider-native ask/task/subagent 대신 runtime 공용 도구를 사용하도록 정책을 통일한다.

**리뷰 체크**

- [ ] 세 provider가 text/tool/status/usage/error/terminal을 같은 의미로 emit한다.
- [ ] provider init/auth 실패도 generator 밖으로 새지 않고 사용자에게 설명 가능한 event가 된다.
- [ ] abort signal이 SDK와 자식 프로세스 트리까지 전달된다.
- [ ] Codex PID 재사용 방어와 SIGTERM→SIGKILL 수거가 안전하다.
- [ ] Claude built-in subagent/workflow, provider-native task/ask 도구 차단 정책이 일치한다.
- [ ] Maestro tool hook과 Codex prompt policy가 공통 도구를 실제로 강제한다.
- [ ] 모델/effort catalog가 SDK 버전과 맞고 invalid override가 조기에 거절된다.
- [ ] usage 단위와 footer 데이터가 provider별로 왜곡되지 않는다.

**관련 test**

- `packages/core/tests/core/agents/*provider*.test.ts`
- `packages/core/tests/core/agents/codex-tree-kill.test.ts`
- 각 저장소의 provider fixture를 golden input으로 비교한다.

### 3.5 Session resume, agent switch, rollout

**Negotium 코드**

- `packages/core/src/storage/conversations.ts`
- `packages/core/src/agents/rollout/*`
- `packages/core/src/agents/fork.ts`
- `packages/core/src/agents/{topic-agent-switch,api-topic-agent-switch}.ts`
- `packages/core/src/agents/topic-cleanup.ts`

**기존 구현과 차이**

- 세 코드 모두 provider native session ID와 provider-neutral conversation log를 함께 사용한다.
- Negotium은 live/cron/peer 같은 session owner를 분리할 수 있어 같은 topic이라도 native ID를 무조건
  공유하면 안 된다.
- agent 변경은 기존 provider session ID를 재사용하는 것이 아니라 공용 로그를 새 provider rollout로
  인코딩하는 과정이다.

**리뷰 체크**

- [ ] session ID의 owner가 topic/agent/context 종류까지 포함해 충돌하지 않는다.
- [ ] session expired는 공용 로그로 한 번만 재구성하고 무한 재시도하지 않는다.
- [ ] agent A→B→A 전환 시 중간 대화가 A의 새 rollout에 포함된다.
- [ ] tool/event-only 레코드가 rollout의 user/assistant pair를 깨지 않는다.
- [ ] fork ask가 원본 native session과 conversation log를 수정하지 않는다.
- [ ] topic 삭제/agent 변경 cleanup이 다른 owner의 session을 지우지 않는다.
- [ ] JSONL append, rotation, clone이 프로세스 충돌에 안전하다.

**관련 test**

- `packages/core/tests/core/agents/{fork,rollout-codec,topic-agent-switch}.test.ts`
- `packages/core/tests/storage/conversations-{clone,rotation}.test.ts`

### 3.6 tell, ask, spawn collaboration

**Negotium 코드**

- `packages/core/src/runtime/inbox.ts`
- `packages/core/src/runtime/ask-callbacks.ts`
- `packages/core/src/query/session-inbox-path.ts`
- `packages/mcp/src/node-tools.ts`
- `packages/core/src/agents/mcp-tools/spawn-subagent.ts`

**기존 구현과 차이**

- Clawgram은 별도 MCP 프로세스와 Telegram bot 사이를 파일 inbox/outbox로 연결한다.
- Otium은 같은 노드 외에 `node/topic` peer 전달과 remote reply route가 있다.
- Negotium local collaboration은 core queue로 수렴하지만 Otium adapter의 remote ask/reply는 아직 없다.

**리뷰 체크**

- [ ] tell은 fire-and-forget이며 대상이 busy면 순서를 보존해 대기한다.
- [ ] ask는 read-only fork이고 답을 정확히 한 번 발신 topic에 주입한다.
- [ ] callback timeout/restart가 원본 topic을 영구 대기 상태로 만들지 않는다.
- [ ] spawn은 새 topic, 독립 session, 비상속 MCP로 재귀 cascade를 막는다.
- [ ] 부모 turn이 중단돼도 이미 시작된 자식의 생명주기 정책이 명확하다.
- [ ] requestId와 tell depth cap이 모든 직접/MCP/peer 입력에서 동일하다.
- [ ] 이름 기반 topic resolution이 중복 이름과 user scope를 안전하게 처리한다.

**관련 test**

- `packages/core/tests/mcp/session-comm/topics.test.ts`
- `packages/core/tests/core/spawn-subagent-tool.test.ts`
- `packages/core/tests/query/inter-session-queue.test.ts`

### 3.7 ask_user, self-config, task, visual

**Negotium 코드**

- `packages/core/src/agents/mcp-tools/{ask-user,self-config,visuals}.ts`
- `packages/core/src/agents/self-config-core.ts`
- `packages/core/src/runtime/{tasks,visual-store,visuals}.ts`
- `packages/core/src/storage/{session-asks,tasks}.ts`

**기존 구현과 차이**

- Clawgram은 task와 self-config는 깊지만 blocking ask card와 Otium식 visual object가 없다.
- Otium은 ask card, visual store/URL, subagent card를 앱 UI와 peer bridge까지 연결한다.
- Negotium core에는 저장과 event가 있지만 실제 상호작용 완성도는 adapter마다 다르다.

**리뷰 체크**

- [ ] ask_user가 turn을 영구 block하지 않고 pending/result/timeout/abort를 영속 처리한다.
- [ ] 답변 user가 topic participant인지 확인한다.
- [ ] self-config의 agent/model/effort/MCP 변경이 현재 turn과 다음 turn 중 어디부터 적용되는지 명확하다.
- [ ] task store가 provider-native todo와 이중 권위가 되지 않는다.
- [ ] visual HTML sanitization/CSP와 media token이 로컬 file을 과도하게 노출하지 않는다.
- [ ] active visual context가 user별이며 다른 사용자의 선택을 덮지 않는다.
- [ ] terminal/Telegram/Otium adapter 각각 지원 또는 fallback을 명시한다.

**관련 test**

- `packages/core/tests/core/agents/ask-user.test.ts`
- `packages/core/tests/core/self-config-core.test.ts`
- `packages/core/tests/storage/tasks-store.test.ts`
- terminal `state.test.ts`

### 3.8 Wiki, skills, vault, 보안 경계

**Negotium 코드**

- `packages/core/src/storage/{wiki,vault,vault-crypto}.ts`
- `packages/core/src/mcp/{wiki-server,vault-server,vault-http,vault-run}.ts`
- `packages/core/src/agents/vault-tool-policy.ts`
- `packages/core/src/security/{sanitize,sensitive-path}.ts`

**기존 구현과 차이**

- Wiki/skills는 Clawgram/Otium에서 이식됐지만 Negotium node의 공용 workspace 책임으로 정리됐다.
- core는 인증 제공자가 아니므로 token/userId를 발급한 host를 신뢰한다.
- Clawgram의 PII mask/unmask는 Negotium에 이식되지 않았다.

**리뷰 체크**

- [ ] wiki query가 다른 user/topic의 private memory를 노출하지 않는다.
- [ ] skill save/index 갱신이 concurrent process와 crash에 안전하다.
- [ ] vault master key와 파일 mode, AES nonce/tag 처리가 안전하다.
- [ ] vault plaintext가 log, MCP error, tool output, process argv에 남지 않는다.
- [ ] sensitive path 차단을 adapter output과 visual/file hook 모두 적용한다.
- [ ] userId를 임의로 넣을 수 있는 외부 HTTP route가 인증 없이 열리지 않는다.
- [ ] PII가 제품 요구라면 core 강제가 아니라 channel/module 정책 중 어디에 둘지 결정한다.

**관련 test**

- `packages/core/tests/core/vault-security.test.ts`
- `packages/core/tests/storage/wiki-*.test.ts`
- `packages/core/tests/core/sanitize.test.ts`

### 3.9 MCP server, catalog, mcp-host

**Negotium 코드**

- `packages/mcp/src/{server,node-tools,sse-transport}.ts`
- `packages/core/src/platform/mcp-config.ts`
- `packages/core/src/mcp/*`
- `packages/mcp-host/src/{manager,manifest,spec}.ts`

**구조적 차이**

Negotium은 MCP를 세 층으로 나눈다.

1. runtime HTTP MCP — session/subagent/task/wiki/vault/node tool.
2. turn별 단명 stdio MCP — core 내장 도구.
3. node manifest 장수명 MCP — browser 등 프로세스와 port를 `mcp-host`가 관리.

Clawgram/Otium에서는 이 책임이 한 앱의 `mcp-config.ts`와 manager들에 더 가깝게 결합돼 있다.

**리뷰 체크**

- [ ] turn token이 user/topic/context에 서명되고 다른 topic 호출에 재사용되지 않는다.
- [ ] Codex HTTP와 Claude/Maestro SSE/stdio 차이가 catalog 의미를 바꾸지 않는다.
- [ ] disabled MCP는 spawn/listener/port를 만들지 않는다.
- [ ] manifest key, command, env, path validation이 임의 실행 경계를 명확히 한다.
- [ ] 같은 server ensure 동시 호출이 프로세스를 중복 생성하지 않는다.
- [ ] health failure/idle eviction/port reuse 후 stale port file이 남지 않는다.
- [ ] Otium execution spec의 MCP 이름과 Negotium catalog 이름을 협상한다.

**관련 test**

- `packages/mcp/tests/server.test.ts`
- `packages/mcp-host/tests/{host,manifest}.test.ts`
- `packages/core/tests/core/{mcp-config,node-mcp-servers}.test.ts`

### 3.10 파일, 첨부, 미디어

**Negotium 코드**

- `packages/core/src/runtime/{attachments,file-hooks}.ts`
- `packages/core/src/media/{text-extractor,video,file-events}.ts`
- `packages/core/src/security/sensitive-path.ts`

**기존 구현과 차이**

| 기준 | 기능 |
|---|---|
| Clawgram | Telegram download, album, mlx-whisper, PDF/doc, video frame, PII, 여러 OCR 경로 |
| Otium runtime-api | upload/file route, 2GB limit, faster-whisper, video/visual, peer file bridge |
| Negotium core | extraction/transcription/video 유틸과 file hook. 실제 upload/download는 host 책임 |

**리뷰 체크**

- [ ] attachment는 topic workspace 아래 안전한 이름으로 materialize된다.
- [ ] symlink/path traversal로 workspace 밖 파일을 읽거나 보내지 않는다.
- [ ] MIME과 확장자만 믿지 않고 크기/timeouts를 제한한다.
- [ ] 임시 음성 chunk와 video frame이 성공/실패/abort 모두에서 정리된다.
- [ ] `[FILE:]` parsing이 일반 사용자 텍스트를 파일 명령으로 오인하지 않는다.
- [ ] host별 upload ID와 local path 변환 권위가 하나다.
- [ ] Otium worker input-file과 output bridge가 구현되기 전 attachment turn을 명시적으로 거절한다.
- [ ] Clawgram 대비 PII/video/OCR parity 누락을 adapter 문서에 표시한다.

**관련 test**

- `packages/core/tests/core/{channel-media,agents/file-events}.test.ts`
- Telegram `gaps.test.ts`, Otium `peer-server.test.ts`

## 4. Node와 module 리뷰

### 4.1 Node lifecycle, module, request plugin

**Negotium 코드**

- `packages/node/src/index.ts`
- `packages/core/src/platform/{lifecycle,modules,node-plugins}.ts`
- `packages/adapter-sdk/src/index.ts`
- `packages/adapter-testkit/src/index.ts`

**기존 구현과 차이**

- Clawgram bot과 Otium API server는 한 startup 파일이 제품 sidecar를 직접 조합한다.
- Negotium은 node, module, adapter, HTTP request plugin을 별도 lifecycle로 분리한다.
- 이 분리가 Negotium의 핵심 가치이므로 기능 parity보다 **비활성 기능 비용 0과 cleanup 대칭성**이 중요하다.

**리뷰 체크**

- [ ] module start 실패 시 이미 시작된 module을 역순 정리한다.
- [ ] 중복 capability와 request handler 이름을 거절한다.
- [ ] adapter/module `stop()`은 여러 번 호출해도 안전하다.
- [ ] SIGINT/SIGTERM/manual stop이 같은 shutdown registry를 사용한다.
- [ ] server가 먼저 닫혀 새 입력을 막고, active turn과 child process를 안전하게 수거한다.
- [ ] 비활성 module은 import/timer/listener/schema/hot-path dispatch를 만들지 않는다.
- [ ] Otium request handler가 `/mcp`와 `/health`를 가로채지 않는다.

**관련 test**

- `packages/core/tests/core/{lifecycle,modules}.test.ts`
- 각 adapter `contract.test.ts`

### 4.2 Cron module

**Negotium 코드**

- `packages/module-cron/src/{module,scheduler,store,context,schedule,scripts}.ts`
- `packages/module-cron/src/mcp-server.ts`

**기존 구현과 차이**

| 기준 | 실행 모델 |
|---|---|
| Clawgram | job별 pm2 cron과 별도 runner, 파일 lock/outbox |
| Otium runtime-api | job별 pm2 cron, DB/API, 별도 runner |
| Negotium | node 내부 timer 하나, SQLite due index, topic별 queue와 공용 Cron context |

이는 구조적 차이이므로 pm2 process 상태 parity가 아니라 결과 의미론을 리뷰한다.

**리뷰 체크**

- [ ] timezone/DST와 DOM/DOW Cron 의미가 기존 기대와 맞다.
- [ ] missed schedule은 무한 replay가 아니라 한 번 coalesce된다.
- [ ] 같은 topic의 여러 job은 직렬이며 user turn을 선점하지 않는다.
- [ ] 다른 topic job은 의도한 수준까지 병렬 실행된다.
- [ ] dispatch 전/후 crash에서 pending/running run 상태가 수렴한다.
- [ ] pause/resume/kill/reset/manual run의 request가 내구적이고 멱등이다.
- [ ] topic별 공용 log와 agent별 native session ID를 분리한다.
- [ ] 성공 5회 rotation이 job별이 아니라 topic별이며 cleanup 실패 시 안전하다.
- [ ] Python script path 검증, timeout, stdout size 제한이 있다.

**관련 test**

- `packages/module-cron/tests/{schedule,scripts,store-scheduler}.test.ts`

## 5. Adapter 리뷰

### 5.1 Terminal adapter

**Negotium 코드**

- `adapters/terminal/src/{client,state,render,app,cli}.ts`

**차이**

- 기존 두 제품에 없는 순수 로컬 reference host다.
- 현재 `EmbeddedNegotiumClient`가 core를 직접 호출하며 remote REST/WS transport는 interface만 준비됐다.
- ask_user/task/tool은 표시하지만 visual 전용 panel과 file interaction은 제한적이다.

**리뷰 체크**

- [ ] TUI reducer가 bus event만으로 결정적 상태를 만든다.
- [ ] 시작 시 storage snapshot과 이후 bus event 사이 race로 message가 빠지지 않는다.
- [ ] Unicode width, resize, narrow layout, scroll이 긴 tool output에서 깨지지 않는다.
- [ ] ask_user 선택과 abort가 정확한 topic/message에 적용된다.
- [ ] alternate screen/raw mode가 crash와 SIGINT에도 복구된다.
- [ ] embedded node를 소유할 때만 stop하며 다른 in-process host를 종료하지 않는다.
- [ ] remote client를 추가해도 state/render에 core import가 새지 않는다.

**관련 test**

- `adapters/terminal/tests/{state,render,contract,app}.test.ts`

### 5.2 Telegram adapter

**Negotium 코드**

- `adapters/telegram/src/{adapter,mapping-store,render,cli}.ts`
- `adapters/telegram/README.md`의 embedding 예제

**Clawgram 대비 현재 차이**

| 영역 | 현재 Negotium adapter |
|---|---|
| 기본 chat/forum | 구현 |
| topic materialize/mapping 복구 | 구현 |
| photo/document/album/voice | 구현 |
| HTML 변환·분할·plain fallback | 구현 |
| durable retry outbox | 구현 |
| PII/video/전문 OCR | 미이식 |
| DM manager·multi-group control plane | 축소 또는 미이식 |
| ask_user/visual UI | 미지원 |
| local Telegram Bot API/macOS helper | 미이식 |

**리뷰 체크**

- [ ] allowlist가 빈 경우 공개 허용인지 fail-closed인지 의도가 명확하다.
- [ ] chat/thread mapping unique constraint와 startup reconciliation이 안전하다.
- [ ] `topic-created` 동시 수신 시 forum topic을 중복 생성하지 않는다.
- [ ] album debounce 중 stop/restart가 부분 turn을 만들지 않는다.
- [ ] 4096 split이 HTML entity/tag/code block을 깨지 않고 각 chunk fallback을 적용한다.
- [ ] 429 retry-after, 5xx/network backoff, dead-letter가 topic 순서를 보존한다.
- [ ] user echo/tool message를 숨기되 final AI message와 file은 누락하지 않는다.
- [ ] unsupported ask_user/visual을 무시하지 말고 사용자에게 fallback을 제공한다.
- [ ] output file sensitive path/symlink를 차단한다.
- [ ] Clawgram을 대체하기 전 PII/video/DM manager 범위를 명시적으로 결정한다.

**관련 test**

- `adapters/telegram/tests/{adapter,forum,gaps,regressions,render,contract}.test.ts`
- Clawgram `tests/telegram/*`의 실사용 regression을 후보로 비교한다.

### 5.3 Otium worker adapter

**Negotium 코드**

- `adapters/otium/src/{central,peer-server,protocol,store}.ts`
- `adapters/otium/src/{turn-bridge,event-backflow,runtime-bridge}.ts`
- `adapters/otium/src/{join,join-cli}.ts`

**Otium runtime-api worker 대비 현재 상태**

| 계약 | 상태 |
|---|---|
| ready/capability/health | 구현 |
| provision/turn/exact abort | 구현 |
| requestId exactly-once | 구현 |
| seq event backflow | 구현 |
| tell/sessions | 구현 |
| remote ask/reply | `/ask` 501, `/reply` 404 |
| input-file | 501 |
| spawn_subagent hub bridge | 구현 |
| ask_user/self-config/file/visual hub bridge | 미구현 또는 worker-local |
| relay TunnelClient | 미구현 |
| one-time invite claim | 미구현; 현재 secret 포함 v0 bundle |

**리뷰 체크**

- [ ] Otium `protocol.ts`와 field/error/status code가 정확히 맞는다.
- [ ] peer token은 central verify와 primary-origin 제한을 빠짐없이 적용한다.
- [ ] requestId replay/conflict/failed retry가 Otium hub 기대와 맞다.
- [ ] seq는 1부터 연속이고 전송 실패 시 후속 event를 건너뛰지 않는다.
- [ ] terminal event가 정확히 하나이며 final text는 message event로 먼저 간다.
- [ ] model/agent 변경 시 stale provider session을 무효화한다.
- [ ] startup에서 interrupted turn request를 hub가 수렴 가능한 상태로 끝낸다.
- [ ] input/output file의 크기, ACL, cleanup, retry를 hub 계약과 맞춘다.
- [ ] remote ask와 bridge request의 TTL/정확히 한 번 소비를 구현한다.
- [ ] relay disconnect/reconnect 시 HTTP 요청과 event journal이 중복 실행되지 않는다.

**관련 test**

- `adapters/otium/tests/{peer-server,turn-bridge,event-backflow,join,contract}.test.ts`
- `scripts/otium-experiment/{hub-setup,run-e2e}.ts`
- `~/otium/apps/runtime-api/tests/peer/peer.test.ts`

### 5.4 private/shared topic 접근과 Otium binding

**Negotium 코드**

- `adapters/otium/src/bindings.ts`
- `adapters/otium/src/store.ts`의 `binding_mode`
- `adapters/otium/src/turn-bridge.ts`의 shared provision 경로
- `packages/core/src/storage/api-topics.ts`의 `access_mode`

**사용자 개념: topic의 adapter 접근 범위 선택**

| 접근 모드 | 접근 가능한 adapter | 기본값 | 원본 |
|---|---|---|---|
| `private` | Terminal, Telegram | 로컬 생성 topic | Negotium topic/message/session |
| `shared` | Otium, Terminal, Telegram | Otium 생성 room 또는 명시적으로 공개한 local topic | 생성 위치에 따른 canonical topic + projection |

로컬 작업은 기본 `private`이고 Otium adapter는 sessions/tell/abort/bind에서 접근할 수 없다. owner가
명시적으로 공개한 topic과 Otium에서 생성한 사용자 room은 `shared`다. Telegram의 표현 제약은 접근
모드가 아니라 adapter capability 차이다.

**의도: 하나의 공유 topic을 여러 adapter가 함께 보여주는 방식**

Otium store의 `binding_mode=mirror|shared`는 사용자 접근 모드가 아니라 transport 구현이다. Otium-owned
room은 worker에 hidden internal mirror를 만들고 hub의 execution spec을 권위로 쓴다. local-origin
`shared` topic은 Otium room을 기존 visible local topic에 직접 연결하며 title, agent, `isSubagent`를
덮어쓰지 않는다. internal mirror를 제품의 사용자 접근 모드로 노출하지 않는다.

`shareOtiumTopic()`/`setOtiumTopicPrivate()` public API와 storage/test에 더해 개발용 CLI
`negotium otium bindings|share|private`가 있다. Otium 제품 UI 선택기는 아직 없다.

topic의 `accessMode`와 `visibility`는 독립적이다. private/shared는 adapter 접근 권한이고 visible/hidden은
picker 노출 여부다. internal mirror는 `visibility: hidden`, `accessMode: shared`인 실행 복제본이다.
terminal topic 목록, CLI `topics`, Telegram `/topics`·`/load`·forum materialization은 hidden topic을
제외한다. 실제 subagent topic의 노출 정책과 mirror의 비노출 정책도 서로 독립적이다.

이 모드에서는 문맥이 겹치는 것이 문제가 아니라 목적이다.

```text
                       하나의 Negotium topic
                  message · provider session · workspace
                         ▲                   ▲
                         │                   │
                    terminal             Otium room
                    full view             full view
                         │
                         └──── Telegram
                              input / notification / summary
```

- Negotium topic/message/session이 원본이다.
- terminal과 Otium은 같은 topic transcript를 표시하는 full projection이다.
- Telegram은 같은 topic에 입력하거나 결과 알림을 받을 수 있지만 full transcript projection은 아니다.
- 어느 adapter에서 시작한 turn이든 같은 topic lock, conversation log, provider session을 사용한다.
- terminal과 Otium 사이에서는 adapter를 바꿔도 이전 대화 transcript와 실행 문맥을 이어서 볼 수 있어야 한다.

Telegram을 full projection으로 보지 않는 이유:

- bot은 terminal/Otium 사용자를 Telegram 원 작성자로 impersonate할 수 없다.
- 임의의 과거 message를 원 timestamp/message ID로 삽입할 수 없다.
- HTML/길이 제한, edit/delete/reaction, thread와 attachment 표현이 다르다.
- ask_user, task card, HTML/Mermaid visual을 같은 UI 상태로 복원할 수 없다.
- 나중에 mapping된 topic의 전체 history를 자연스러운 Telegram 대화로 backfill하기 어렵다.

이 차이는 adapter SDK v2의 `projection` 메타데이터로도 고정한다. terminal은
`full/historyBackfill`, Telegram은 `live-only/no-backfill`, Otium은 full transcript surface이지만 현재
local history backfill이 없어 `full/no-backfill`이다. 외부 adapter 작성자는 Telegram/Otium에서
`relayed`로 표시한다.

**현재 구현에서 아직 다른 점**

- 로컬 생성 topic은 DB에서 `accessMode: private`가 기본이고 Terminal·Telegram은 계속 접근할 수 있다.
- Otium peer sessions/tell/topic-scoped abort/bind는 `shared` topic만 허용한다.
- `share`는 owner topic을 shared로 승격하고, `private`는 모든 Otium binding을 제거한 뒤 local history를 보존한다.
- terminal은 core storage snapshot과 `RuntimeBus`를 직접 읽으므로 local topic 전체 문맥을 볼 수 있다.
- Otium peer turn은 같은 local topic/provider 문맥을 사용하고 그 turn의 AI event를 hub로 돌려보낸다.
- Otium-origin room은 개념상 shared지만 현재 worker에는 hidden execution mirror만 있다. 이를 Terminal·Telegram의
  visible topic으로 투영할 identity/membership 계약과 hub projection endpoint는 아직 없다.
- 그러나 `event-backflow.ts`는 active peer forwarder가 있을 때만 event를 전송한다. terminal에서
  시작된 user message와 AI response는 현재 Otium hub message history로 자동 복제되지 않는다.
- 따라서 **실행 문맥 공유는 구현됐지만 모든 adapter에서 같은 transcript를 보는 기능은 아직 부분 구현**이다.

shared mode에서는 다음 정책을 더 정해야 한다.

- local Negotium topic 설정과 Otium room 설정 중 어떤 것을 화면과 turn에 표시할지
- terminal에서 생긴 message를 Otium room에 어떤 API와 identity로 복제할지
- Otium human message를 local store에 중복 없이 연결할 stable source message ID
- adapter가 잠시 끊겼을 때 transcript를 seq journal로 catch-up하는 방식
- local terminal user turn과 Otium user turn이 충돌할 때 같은 user-priority 규칙
- file/visual/ask_user처럼 channel별 표현이 다른 event의 projection 방식
- unbind/rebind가 topic history와 provider session을 보존하는 방식
- shared→private 후 Otium에 이미 기록된 transcript의 retention/표시 방식
- Telegram에는 live AI result, 명시적 relay, topic summary 중 무엇만 보낼지

**리뷰 체크**

- [ ] topic 설정 UI에서 `private`와 `shared`를 명시적으로 선택한다. 개발용 CLI는 구현됨.
- [x] 로컬 생성 기본값을 `private`로 두고 `shared` 공개는 owner의 명시적 opt-in으로 한다.
- [x] private topic은 Terminal·Telegram에서 접근하고 Otium peer route에서는 숨긴다.
- [x] Otium internal mirror를 사용자 접근 모드와 분리한다.
- [x] local-origin shared mode의 원본을 Negotium topic/message/session으로 명시한다.
- [ ] Otium room을 독립 hub-authoritative room이 아니라 해당 topic의 projection으로 구분한다.
- [ ] terminal과 Otium 중 어디서 시작한 message도 다른 쪽이 catch-up할 수 있다.
- [ ] source adapter/message ID와 binding seq로 loop와 중복 message를 방지한다.
- [ ] 두 channel의 동시 user turn이 같은 topic의 user-preemption 규칙을 따른다.
- [ ] shared topic의 ask/spawn/file/visual을 adapter별로 표시하거나 명시적 fallback한다.
- [ ] Otium identity와 local Negotium participant를 안전하게 매핑한다.
- [ ] Otium room config가 local topic 설정을 덮는지 단순 표시만 하는지 결정한다.
- [x] Telegram은 adapter capability상 full history catch-up 대상이 아님을 선언한다. notification/summary 세부 계약은 남음.
- [x] unbind가 local topic을 삭제하거나 자동으로 private 전환하지 않는다.
- [x] `private`→`shared` 전환은 local history를 보존하고 Otium binding을 명시적으로 추가한다.
- [x] `shared`→`private` 전환은 모든 Otium binding을 제거하고 local history를 보존한다.
- [ ] shared→private가 이미 Otium에 저장된 과거 transcript를 삭제하지 않음을 UI에서 안내한다.
- [ ] rebind 후 전체 transcript 재복사 대신 마지막 binding seq부터 수렴한다.
- [ ] hidden mirror(hub 권위)와 shared projection(Negotium 권위)을 각각 E2E test한다.

**관련 test**

- `adapters/otium/tests/bindings.test.ts`

현재 `bindings.test.ts`는 private 기본값, 명시적 shared 승격, private 직접 bind 거절, 모든 binding을
제거하는 private 전환, hidden internal mirror 공유 거절을 검증한다. `peer-server.test.ts`는 private topic이
Otium sessions/tell/abort/bind에서 차단되는지 검증한다. terminal turn → Otium 표시, Otium turn →
terminal 표시, 재연결 catch-up, 중복 방지 test가 추가돼야 “같은 문맥을 양쪽에서 본다”는 목표가
완료된다. Telegram은 이 E2E의 full transcript 대상이 아니라 별도 notification/fallback test 대상이다.

## 6. CLI와 조합 리뷰

### 6.1 CLI와 여러 adapter 동시 실행

**Negotium 코드**

- `apps/cli/src/main.ts`
- `packages/node/src/index.ts`
- `apps/cli/src/commands/{chat,adapters,cron,mcp,vault,topics}.ts`

**차이**

- Clawgram과 Otium runtime-api는 각자 channel 하나의 제품 startup이다.
- Negotium CLI는 node 하나에 terminal, Telegram, Otium adapter를 동시에 붙일 수 있다.
- 이 조합은 process 효율은 좋지만 topic/session/state directory를 실제로 공유한다.

**리뷰 체크**

- [ ] state directory 하나에 long-lived node process 하나만 실행하도록 막거나 명확히 경고한다.
- [ ] 여러 adapter가 같은 userId/topic을 볼 때 message echo와 turn 선점 규칙이 명확하다.
- [ ] adapter start 중간 실패 시 앞서 시작된 adapter와 node를 역순 정리한다.
- [ ] stop handler가 중복 등록돼 node를 두 번 종료하지 않는다.
- [ ] terminal 종료가 Telegram/Otium adapter 종료까지 의도대로 전파된다.
- [ ] `--with=all`과 env 자동 감지가 secret이 일부만 있을 때 fail-closed한다.
- [ ] package build 결과가 source path alias나 로컬 checkout에 암묵적으로 의존하지 않는다.

## 7. 종료, 복구, 관측성 리뷰

**Negotium 코드**

- `packages/core/src/platform/{lifecycle,logger}.ts`
- `packages/core/src/storage/activity-log.ts`
- `packages/core/src/query/state.ts`
- 각 queue/store의 startup recovery

**리뷰 체크**

- [ ] SIGINT/SIGTERM에서 새 입력 차단 → active turn abort → child reap → DB/server close 순서가 정해져 있다.
- [ ] 강제 종료 후 `.processing`, running query, peer request, cron run이 자동 수렴한다.
- [ ] retry 가능한 오류와 permanent 오류가 log/사용자 메시지에서 구분된다.
- [ ] token, invite bundle, vault value, file path가 구조화 log에 노출되지 않는다.
- [ ] activity log rotation이 disk를 무한 사용하지 않고 현재 쓰기와 경합하지 않는다.
- [ ] health endpoint가 process alive뿐 아니라 필요한 worker/module 상태를 과장하지 않는다.
- [ ] adapter별 delivery failure를 core turn success와 별도 관측할 수 있다.
- [ ] shutdown/recovery scenario test가 실제 child process와 SQLite를 포함한다.

## 8. 기능 하나를 끝냈다고 판단하는 기준

다음 산출물이 모두 있어야 해당 기능 리뷰를 완료한다.

- [ ] 기존 구현과 다른 점을 한 문단으로 기록했다.
- [ ] 차이를 유지/gap/범위 밖 중 하나로 판정했다.
- [ ] 상태 권위와 실패 시 복구 주체를 지정했다.
- [ ] core와 adapter/product 책임이 섞이지 않는다.
- [ ] happy path, abort, retry/replay, restart test가 있다.
- [ ] 세 provider 또는 지원 대상 provider별 차이를 확인했다.
- [ ] 지원하지 않는 host 기능은 silent drop 대신 fallback/오류가 있다.
- [ ] 관련 문서와 package public API를 갱신했다.
- [ ] 전체 test가 아니라 해당 기능의 회귀 test 목록을 남겼다.

리뷰 결론은 각 장 아래 판정란을 채우고, 실제 수정이 필요하면 별도 issue/task로 분리한다. 이렇게 하면
“Clawgram/Otium과 다르다”는 사실과 “Negotium이 잘못됐다”는 판단을 구분할 수 있다.
