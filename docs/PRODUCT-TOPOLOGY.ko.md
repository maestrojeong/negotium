# Clawgram · Negotium · Otium 제품 경계

> 결론: 세 제품을 한 프로세스나 한 UI로 합치지 않는다. 실행 엔진과 기능은 Negotium 패키지로
> 수렴시키고, Clawgram과 Otium은 서로 다른 호스트 조합을 사용한다.

## 1. 세 제품의 역할

| 제품 | 주 사용자/범위 | 권위(authority) | 조합 |
|---|---|---|---|
| **Clawgram** | 개인 1명, 보통 컴퓨터 1대 | 로컬 사용자가 topic·메시지·세션의 주인 | Negotium core + Telegram/개인 채널 + 필요한 로컬 모듈 |
| **Negotium** | 제품이 아니라 실행 커널과 모듈 생태계 | 한 노드 안의 turn·session·tool 실행 | core, MCP, 모듈 lifecycle, Cron, 채널/Otium adapter |
| **Otium** | 여러 사용자와 초대된 여러 컴퓨터 | workspace hub가 멤버십·메시지·방 배치의 원본 | Otium control plane + 각 컴퓨터의 Negotium worker + `@negotium/adapter-otium` |

Clawgram은 개인용으로 단순하게 남는다. Otium의 조직, 초대, 권한, 노드 목록을 Clawgram이나
Negotium core에 넣지 않는다. 반대로 에이전트 실행, Cron, 브라우저, 메모리 같은 기능을 Otium
runtime-api에 다시 구현하지 않고 Negotium 모듈을 조합한다.

## 2. 코드 결합 규칙

```
Clawgram host ─┐
CLI host ──────┼─► @negotium/core ◄─ module-cron / module-media / ...
Otium worker ──┘          ▲
                          └─ adapter-otium ─────► Otium hub/central/relay
```

- core는 특정 제품, 초대 서버, Telegram, Otium DB를 import하지 않는다.
- 호스트가 `startNode({ modules: [...] })`와 adapter lifecycle을 명시적으로 조합한다.
- 모듈은 안정적인 capability ID를 광고한다. 예: `scheduler.cron.v1`, 이후
  `media.transcribe.v1`. Otium adapter는 별도의 peer capability endpoint를 제공한다.
- 모듈 전용 테이블은 namespace를 사용한다. 예: `negotium_cron_*`.
- 다른 프로세스의 도구가 필요하면 module startup에서 MCP catalog에 한 번 등록하고 shutdown에서
  정확히 해제한다.

## 3. Otium 컴퓨터 초대 흐름

최종 UX는 다음 하나다.

```
Otium workspace admin: "컴퓨터 초대" → 1회용 코드
새 컴퓨터: negotium otium join <code>
  → central에서 코드 claim
  → 이 컴퓨터 전용 node credential 발급
  → ~/.negotium/data/otium-join.json에 0600으로 저장
  → adapter-otium이 outbound relay/HTTPS 연결
  → Otium 노드 피커에 capability·상태 표시
  → 방을 노드에 배치하면 그 방의 turn만 해당 컴퓨터에서 실행
```

초대 코드는 영구 secret이 아니다. central이 해시만 저장하고 다음을 강제한다.

- one-time claim, 짧은 TTL, workspace와 권한 범위 고정
- claim 결과는 새 node ID와 회전 가능한 node credential
- credential은 workspace 하나, node 하나에만 유효
- 관리자가 revoke하면 새 peer 요청을 즉시 거절
- peer 요청은 `(workspace, fromNode, toNode)` 범위의 단명 토큰과 idempotency key 사용
- NAT 뒤 컴퓨터는 인바운드 포트를 열지 않고 relay에 outbound 연결만 생성

Otium central에 실제 `node-invites` claim API가 생기기 전에는 Negotium이 임의 포맷의 초대 코드를
운영 계약으로 확정하지 않는다. 현재 wire 계약은 `OTIUM-COUPLING.md`, direct URL 기반 v0 실행 절차는
`../scripts/otium-experiment/README.md`에 있다.

## 4. 상태와 데이터 소유권

| 데이터 | 원본 | worker 보관 |
|---|---|---|
| workspace 멤버십·노드 권한·방 배치 | Otium hub/central | capability/credential 캐시만 |
| 사용자가 보는 메시지와 첨부 메타데이터 | Otium hub | 실행에 필요한 입력과 임시 파일만 |
| provider session/rollout | 배치된 Negotium worker | 해당 worker가 원본, hub는 opaque session key만 |
| turn request와 전달 seq journal | 양쪽에 각자 durable journal | requestId로 재실행 방지, seq로 이벤트 유실 감지 |
| 개인 Clawgram 데이터 | 개인 Negotium node | Otium과 공유하지 않음 |

방 이동은 무조건 명시적이다. provider session이 있는 방을 조용히 다른 노드로 옮기지 않는다.
새 노드에서 새 세션을 시작하거나, 지원되는 provider-native migration을 별도 기능으로 제공한다.

### 4.1 Topic 접근 모드: private / shared

사용자에게 보이는 두 모드는 Otium transport가 아니라 topic의 adapter 접근 범위다.

| 접근 모드 | 접근 adapter | 기본 생성 위치 | 의미 |
|---|---|---|---|
| `private` | Terminal, Telegram | 로컬 Negotium | 로컬 작업용이며 Otium sessions/tell/abort/bind에서 보이지 않음 |
| `shared` | Otium, Terminal, Telegram | Otium 또는 명시적으로 공개한 local topic | adapter가 달라도 같은 topic 실행 문맥을 공유 |

로컬 topic은 기본 `private`, Otium에서 생성된 사용자 room은 기본 `shared`다. local owner가
`private` topic을 Otium에 공개할 때만 `shared`로 전환한다. `shared` topic을 `private`로 되돌리면 모든
Otium binding과 이후 동기화를 끊지만 local topic/history는 보존한다. 이미 Otium에 기록된 과거
메시지를 소급 삭제하는 의미는 아니다.

Otium store의 `binding_mode=mirror|shared`는 이 사용자 모드와 다른 내부 transport다. `mirror`는
Otium-owned room의 turn/session을 worker에서 실행하기 위한 hidden replica이며 사용자 접근 모드가
아니다. local-origin shared topic은 `shared` binding을 사용한다.

`shared`에서는 문맥 공유가 의도된 동작이다. adapter가 달라도 같은 topic lock, conversation log,
workspace, provider session을 사용한다. local-origin shared topic의 Otium room은 Negotium topic의
channel projection이므로 terminal에서 생긴 message도 Otium이 binding seq 이후를 catch-up할 수 있어야
한다. Otium-origin room은 hub가 원본이고 worker mirror는 실행 세부사항이다.

Telegram은 이 full projection에 포함하지 않는다. 동일 topic에 prompt를 넣거나 AI 결과·요약 알림을
받는 제한형 channel로 사용할 수 있지만, Telegram Bot API는 외부 사용자의 원 작성자 표시, 과거 history
삽입, visual/ask/task 상태 복원을 지원하지 않아 terminal/Otium과 동일 transcript를 보장할 수 없다.

core topic에는 `accessMode: private|shared`와 `visibility: visible|hidden`이 별도로 저장된다. access mode는
adapter 권한이고 visibility는 picker 노출 여부다. Otium internal mirror만 `hidden`이며 실제 subagent
여부인 `isSubagent`와도 섞지 않는다. 개발자는 `negotium otium share|private`로 접근 모드를 전환하고
`bindings`로 내부 transport를 점검할 수 있다. Otium 제품 UI 선택기는 후속 작업이다.

현재 adapter는 shared local topic에서 Otium peer turn을 실행하고 terminal에 같은 문맥을 보여주는
단계까지 구현됐다. local-origin turn을 Otium transcript로 양방향 동기화하는 durable projection journal은
아직 남아 있다. Otium-origin shared room을 Terminal·Telegram의 visible topic으로 투영하는 identity 및
membership 계약도 아직 없다. 따라서 access mode 저장·차단은 구현됐지만 Otium-origin room의
all-adapter projection은 부분 구현이다. 상세 리뷰 기준은 `NEGOTIUM-FEATURE-REVIEW.ko.md` 5.4장을 따른다.
adapter SDK v2의 projection 선언은 terminal=`full/backfill`, Otium=`full/no-backfill`,
Telegram=`live-only/no-backfill`로 이 차이를 코드 계약에도 남긴다.

## 5. 성능 불변식

“모듈로 합친다”는 모든 기능을 항상 켠다는 뜻이 아니다.

- 비활성 모듈: import 0, timer/listener 0, schema migration 0, 모듈별 turn hot-path dispatch 0.
- 활성 모듈: node startup에서 한 번 등록하고 event/query 경로에는 O(1) 조회만 추가.
- Cron: job별 프로세스 없이 timer 하나, `(enabled, next_run_at)` 인덱스 조회 하나. topic별 공용 Cron
  문맥과 직렬 실행 큐를 사용하며 agent별 native resume ID는 공용 로그 아래에서 재구성한다.
- Otium peer: direct URL 구성은 요청 시 HTTP만 사용하고, NAT 환경의 relay 구성은 worker마다 outbound
  터널 하나만 둔다. 어느 쪽도 배치된 방의 입력/이벤트만 전송하며 SQLite 전체를 동기화하지 않는다.
- 파일: turn에 필요한 파일만 content-addressed/streaming 전송하고 완료 후 정책에 따라 정리.
- 요청: requestId 멱등 저널과 연속 seq 이벤트를 사용해 재연결 시 전체 대화를 재전송하지 않는다.

성능 회귀 기준은 기능 수가 아니라 활성 구성별로 잡는다: core-only idle, core+Cron idle/due,
Otium peer idle/turn throughput을 각각 측정한다.

## 6. 구현 단계와 현재 상태

1. **완료** — 명시적 node module lifecycle, reverse-order cleanup, 중복 capability 방지.
2. **완료** — 동적 MCP capability 등록/해제.
3. **완료** — `@negotium/module-cron`: 영속 job/run/request, timezone Cron, topic 공유 Cron 문맥,
   prompt/Python-script source, CLI와 MCP 관리, 사용자 turn 우선순위 유지.
4. **부분 완료** — `@negotium/adapter-otium`: central 인증·디스커버리, capability/health,
   provision/turn/abort/tell/session, durable request claim, 연속 seq event journal. 현재 direct URL
   real-turn E2E와 `spawn_subagent` hub bridge까지 검증됐으며 remote ask/reply, input-file,
   ask_user/self-config/file/visual bridge, relay client는 남아 있다.
5. **Otium 변경 필요** — one-time node invite create/claim API와 workspace 노드 관리 UI.
6. **후속** — remote ask, file/visual, ask_user/self-config bridge를 순서대로 연결.

`adapter-otium`은 core에 조건문을 계속 추가하는 형태가 아니라 노드의 adapter/request-handler
경계로 구현한다. 그래야
Clawgram과 core-only 노드는 peer 코드나 relay 연결 비용을 전혀 부담하지 않는다.

현재 구현 세부와 남은 gap은 `NEGOTIUM-FEATURE-REVIEW.ko.md` 5.3~5.4장과
`OTIUM-COUPLING.md` 4장을 따른다.
