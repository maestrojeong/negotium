# Clawgram · Negotium · Otium 제품 경계

> 결론: 세 제품을 한 프로세스나 한 UI로 합치지 않는다. 실행 엔진과 기능은 Negotium 패키지로
> 수렴시키고, Clawgram과 Otium은 서로 다른 호스트 조합을 사용한다.

## 1. 세 제품의 역할

| 제품 | 주 사용자/범위 | 권위(authority) | 조합 |
|---|---|---|---|
| **Clawgram** | 개인 1명, 보통 컴퓨터 1대 | 로컬 사용자가 topic·메시지·세션의 주인 | Negotium core + Telegram/개인 채널 + 필요한 로컬 모듈 |
| **Negotium** | 제품이 아니라 실행 커널과 모듈 생태계 | 한 노드 안의 turn·session·tool 실행 | core, MCP, 모듈 lifecycle, Cron, 이후 Otium peer/media/macOS 모듈 |
| **Otium** | 여러 사용자와 초대된 여러 컴퓨터 | workspace hub가 멤버십·메시지·방 배치의 원본 | Otium control plane + 각 컴퓨터의 Negotium worker + `otium-peer` 모듈 |

Clawgram은 개인용으로 단순하게 남는다. Otium의 조직, 초대, 권한, 노드 목록을 Clawgram이나
Negotium core에 넣지 않는다. 반대로 에이전트 실행, Cron, 브라우저, 메모리 같은 기능을 Otium
runtime-api에 다시 구현하지 않고 Negotium 모듈을 조합한다.

## 2. 코드 결합 규칙

```
Clawgram host ─┐
CLI host ──────┼─► @negotium/core ◄─ module-cron / module-media / ...
Otium worker ──┘          ▲
                          └─ module-otium-peer ─► Otium hub/central/relay
```

- core는 특정 제품, 초대 서버, Telegram, Otium DB를 import하지 않는다.
- 호스트가 `startNode({ modules: [...] })`로 모듈을 명시적으로 조합한다.
- 모듈은 안정적인 capability ID를 광고한다. 예: `scheduler.cron.v1`, 이후
  `otium.peer.v1`, `media.transcribe.v1`.
- 모듈 전용 테이블은 namespace를 사용한다. 예: `negotium_cron_*`.
- 다른 프로세스의 도구가 필요하면 module startup에서 MCP catalog에 한 번 등록하고 shutdown에서
  정확히 해제한다.

## 3. Otium 컴퓨터 초대 흐름

최종 UX는 다음 하나다.

```
Otium workspace admin: "컴퓨터 초대" → 1회용 코드
새 컴퓨터: negotium join <code>
  → central에서 코드 claim
  → 이 컴퓨터 전용 node credential 발급
  → ~/.negotium/otium.json에 0600으로 저장
  → otium-peer 모듈이 outbound relay/HTTPS 연결
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
확정하지 않는다. 현재 wire 수준의 상세 설계와 v0/v1 이행안은 `OTIUM-COUPLING.md` 5장에 있다.

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

## 5. 성능 불변식

“모듈로 합친다”는 모든 기능을 항상 켠다는 뜻이 아니다.

- 비활성 모듈: import 0, timer/listener 0, schema migration 0, 모듈별 turn hot-path dispatch 0.
- 활성 모듈: node startup에서 한 번 등록하고 event/query 경로에는 O(1) 조회만 추가.
- Cron: job별 프로세스 없이 timer 하나, `(enabled, next_run_at)` 인덱스 조회 하나. job마다 독립 세션.
- Otium peer: worker마다 outbound 연결 하나. 배치된 방의 입력/이벤트만 전송하며 SQLite 전체를
  동기화하지 않는다.
- 파일: turn에 필요한 파일만 content-addressed/streaming 전송하고 완료 후 정책에 따라 정리.
- 요청: requestId 멱등 저널과 연속 seq 이벤트를 사용해 재연결 시 전체 대화를 재전송하지 않는다.

성능 회귀 기준은 기능 수가 아니라 활성 구성별로 잡는다: core-only idle, core+Cron idle/due,
Otium peer idle/turn throughput을 각각 측정한다.

## 6. 구현 단계와 현재 상태

1. **완료** — 명시적 node module lifecycle, reverse-order cleanup, 중복 capability 방지.
2. **완료** — 동적 MCP capability 등록/해제.
3. **완료** — `@negotium/module-cron`: 영속 job/run/request, timezone Cron, 독립 session,
   CLI와 MCP 관리, 사용자 turn 우선순위 유지.
4. **다음** — `@negotium/module-otium-peer`: central 인증·디스커버리, provision/turn/event journal,
   capability endpoint, relay client.
5. **Otium 변경 필요** — one-time node invite create/claim API와 workspace 노드 관리 UI.
6. **후속** — remote ask, file/visual, ask_user/spawn/self-config bridge를 순서대로 연결.

`otium-peer`는 core에 조건문을 계속 추가하는 형태가 아니라 하나의 module로 구현한다. 그래야
Clawgram과 core-only 노드는 peer 코드나 relay 연결 비용을 전혀 부담하지 않는다.
