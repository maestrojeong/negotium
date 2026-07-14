# Adapter 패키징과 동시 실행

Negotium의 first-party adapter는 한 monorepo에서 관리하되 npm package는 분리한다.

```text
@negotium/cli
├── @negotium/node                 하나의 runtime process
├── @negotium/adapter-terminal     로컬 TUI
├── @negotium/adapter-telegram     Telegram chat/forum mapping
└── @negotium/adapter-otium        Otium peer/workspace mapping

adapter 3개 ── @negotium/adapter-sdk의 같은 lifecycle contract
            └─ @negotium/core의 topic/task/runtime bus를 공유
```

## 왜 이 구조인가

- 소스와 버전 변경은 한 PR에서 함께 검증할 수 있다.
- adapter마다 독립적인 `exports`, `bin`, 의존성, README를 가지므로 필요한 것만 설치할 수 있다.
- `@negotium/cli`는 세 adapter를 모두 dependency로 가져가므로 사용자에게는 한 번의 설치로 보인다.
- 별도 repository 사이의 `bun link`, `file:../...`, 특정 홈 디렉터리 경로 의존성이 없다.
- 기존 adapter repository는 cutover가 끝날 때까지 보존할 수 있지만 canonical source는 이 repository의
  `adapters/*`다.

따라서 adapter 구현을 한 npm package로 합치지는 않는다. 저장소는 합치고 배포 단위는 분리하는 것이
channel별 선택 설치와 공동 runtime 관리 양쪽을 만족한다.

## 설치와 실행

아직 npm registry에는 publish하지 않았다. publish 후에는 다음 한 줄로 CLI와 adapter 세 개가 설치된다.

```bash
npm install --global negotium
```

하나만 독립 실행할 수도 있다.

```bash
negotium terminal
negotium telegram
negotium otium join <invite-code>
negotium otium serve
negotium otium bindings
negotium otium share <host-topic-id> <local-topic-id> --user <user-id>
negotium otium private <local-topic-id> --user <user-id>
```

같은 node에서 동시에 쓰려면 반드시 combined host를 사용한다.

```bash
negotium start terminal telegram otium
# 또는
negotium start all
```

combined host는 `@negotium/node`를 한 번만 시작하고 각 adapter에 같은 runtime bus와 topic store를
연결한다. 종료는 node lifecycle이 관리한다. active turn을 먼저 abort해 channel terminal event를
보낸 뒤(priority 120), adapter/backflow를 닫는다(priority 100). 같은
`NEGOTIUM_STATE_DIR`를 사용하는 standalone process 여러 개를 따로 띄우면 안 된다.

## 무엇을 공유하고 무엇을 분리하는가

| 상태 | 소유자 | 세 adapter 간 관계 |
|---|---|---|
| topic, message, provider session | `@negotium/core` | 공유 |
| task, wiki, skill, vault | `@negotium/core`/runtime MCP | 공유 |
| Cron schedule | 같은 node의 Cron module | 공유 |
| Telegram chat/thread ID | Telegram mapping DB | Telegram 전용 |
| Otium host room ID/peer request | Otium binding DB | Otium 전용 |
| TUI selection/scroll/composer | Terminal process memory | Terminal 전용 |

Claude, Codex, Maestro 중 어느 provider가 turn을 실행해도 task의 canonical storage는 같다. Adapter는
provider별 task copy를 만들지 않는다.

## 기존 topic 불러오기

Terminal은 node의 topic 목록을 직접 읽으므로 추가 mapping 없이 모든 보이는 topic을 선택할 수 있다.

Telegram에서는 현재 chat 또는 forum thread에서 다음 명령을 쓴다.

```text
/load <topic-name-or-id>
/unload
```

`/load`는 기존 topic에 durable mapping을 추가한다. 다른 Telegram chat도 같은 topic에 동시에 연결될
수 있다. `/unload`는 Telegram mapping만 지우며 Negotium topic과 그 history/task는 보존한다.

Otium hub는 primary-authenticated peer route로 기존 local topic을 binding한다.

```text
POST /api/v1/peer/bind
{ v, userId, hostTopicId, localTopicId }

POST /api/v1/peer/unbind
{ v, hostTopicId }
```

기본 placement는 hidden mirror topic을 만들지만, shared binding은 local topic의 title, agent, history,
task를 그대로 사용한다. unbind도 local topic을 삭제하지 않는다.

사용자 topic의 접근 모드는 `private`/`shared`다. `private`는 Terminal·Telegram에서만 접근하고,
`shared`는 Otium에서도 sessions/tell/abort/bind 대상으로 접근한다. 로컬 생성 기본값은 `private`이며
`share`가 owner의 topic을 명시적으로 `shared`로 공개하면서 Otium room을 연결한다. `private`는 해당
local topic의 모든 Otium binding을 제거하지만 local history를 삭제하지 않는다. 이미 Otium hub에
복제된 과거 메시지를 회수하지는 않는다.

`bindings`가 표시하는 `internal-mirror`/`shared-binding`은 사용자 접근 모드가 아니라 Otium transport다.
hidden mirror는 Otium-owned room을 실행하기 위한 worker 내부 복제본이며 picker에 노출되지 않는다.
host node는 기본적으로 workspace primary를 찾고, 개발 중에는 `--host-node <cell-id>`로 명시할 수 있다.
Otium-origin shared room을 Terminal·Telegram의 visible topic으로 만드는 projection/identity 계약은 아직
미구현이므로 현재 완성된 경로는 local-origin topic의 private/shared 전환과 Otium 접근 차단이다.

## Transcript projection capability

adapter SDK v2는 channel 차이를 숨기지 않고 definition에 선언한다.

| adapter | transcript | history backfill | 외부 author |
|---|---|---:|---|
| terminal | `full` | 지원 | `native` |
| Otium | `full` | 아직 미지원 | `relayed` |
| Telegram | `live-only` | 미지원 | `relayed` |

Otium의 `historyBackfill: false`는 shared local topic의 기존/terminal-origin message를 hub transcript로
동기화하는 일반 projection endpoint와 journal이 아직 없다는 뜻이다. binding mode와 UI 표현 capability를
같은 개념으로 취급하지 않는다.

## 개발 규칙

새 adapter/app package 내부 import는 `@/`를 `src/` root로 사용한다. 배포 빌드는 JS에서 내부 모듈을
bundle하고 `.d.ts`의 alias를 portable relative path로 바꾸므로 npm 소비자에게 `@/`가 노출되지 않는다.

```bash
bun install
bun run check       # Biome lint/format check + 전체 build
bun test            # 전체 test suite
```

모든 배포 package는 `build`, `lint`, `prepack`을 가지며, 타입 검사가 별도인 package는 `check`,
테스트가 있는 package는 `test`를 추가로 가진다.
