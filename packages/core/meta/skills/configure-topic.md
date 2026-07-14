# 토픽 MCP 설정 (Configure Topic MCP)

> **Description**: 현재 토픽의 MCP 서버를 설정할 때 트리거. "MCP 줄여줘", "playwright 추가해줘", "커스텀 서버 등록", "컨텍스트 줄여줘", "MCP 설정" 요청 시 적용.

## Required MCP
- runtime (항상 사용 가능: send_file, self-config, visual tools)
- session-comm (항상 사용 가능)
- token-stats (항상 사용 가능)
- wiki (항상 사용 가능)
- system-health / agent-health (항상 사용 가능)

## 가용 기본 서버 목록
```
playwright        - 브라우저 자동화
paddleocr         - 한/중/일 정밀 OCR
token-stats       - 토큰 사용량 조회
session-comm      - 세션 간 통신 (비활성화 불가)
wiki              - wiki 지식베이스 검색 (wiki_query, wiki_topic_brief)
background-bash   - 턴을 넘어 살아남는 장기 bash 작업
vault             - 민감 값 조회/치환(claude/maestro만)
mcp-manager       - MCP 구성 확인/변경
topic-admin       - General 토픽의 topic/admin 관리
```

## 프로세스

### 서버 화이트리스트 설정 (필요한 서버만 활성화)
```
mcp__session-comm__configure_mcp(
  enabled=["playwright", "background-bash", "paddleocr"]
)
# 필수 서버는 enabled에 넣지 않아도 항상 포함됨
```

### 커스텀 서버 추가
REST topic runtime에서는 커스텀 MCP 서버 등록을 지원하지 않는다.
필요하면 먼저 backend catalog(`src/platform/mcp-config.ts`)에 서버를 추가하고,
그 이름을 topic config에서 선택 가능하게 만든다.

### 현재 설정 확인
```
mcp__session-comm__get_mcp_config()
```

### 설정 초기화 (전체 기본값 복원)
```
mcp__session-comm__configure_mcp(enabled=null, extra={})
```

## 스킬 기반 자동 설정 패턴

토픽에서 사용할 스킬을 파악하고 필요한 MCP만 활성화:

1. 이 토픽에서 사용하는 스킬 목록 확인 (`.claude/skills/` 또는 `skill.md`의 `## Required MCP` 섹션)
2. 필요한 선택 서버 목록 합산 (필수 서버는 자동 포함)
3. `configure_mcp(enabled=[...])` 호출

예시 — 코딩 전용 토픽 (브라우저/OCR 불필요):
```
configure_mcp(enabled=["background-bash"])
```

예시 — Gmail 토픽 (playwright 필요):
```
configure_mcp(enabled=["playwright", "background-bash"])
```

## Gotchas
- 변경 후 **반드시 다음 세션부터 적용** — 현재 세션엔 즉시 반영 안 됨
- `enabled=[]`는 선택 서버 비활성화, `enabled=null`은 기본값 복원
- 알 수 없는 서버 이름은 거부됨. 선택 가능 서버 목록은 `get_mcp_config`에서 확인
