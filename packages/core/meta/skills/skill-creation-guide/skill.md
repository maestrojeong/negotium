---
name: skill-creation-guide
description: "스킬 만들기, skill 추가, 워크플로우 정리, skill_save 사용법, 스킬 포맷, 스킬 작성 원칙, skill-creation-guide"
---

# 스킬 작성 가이드

## 트리거
- 새 스킬을 만들거나 기존 스킬을 개선할 때
- wiki-archiver Step 7 실행 시
- "스킬 만들어줘", "skill 추가", "워크플로우 정리" 요청 시

## 생성/업데이트 절차

1. **기존 스킬 확인**: `skill_query("<스킬 이름 또는 설명>")` — 유사한 스킬이 있으면 업데이트, 없으면 신규 생성
2. **저장**: `skill_save(name="<kebab-case>", content="<markdown>")` — 기존 스킬이면 `## Gotchas` 자동 merge
3. **인덱스 업데이트**: `index_upsert(slug="<kebab-case>", description="<한 줄>", kind="skill")`

## 스킬 파일 포맷

```markdown
---
name: kebab-case-name
description: "키워드1, 키워드2, 사용자가 쓸 법한 트리거 문구들 — skill_query 매칭 핵심 (300자 이내)"
---

# 스킬 이름

## 트리거
- 사용자가 "xxx" 요청 시 (1-3줄)

## 프로세스
### 1. 첫 번째 단계
- 구체적 행동
### 2. 두 번째 단계
- 구체적 행동

## Gotchas
- 실패했던 사례, 주의사항 (시간이 지나면서 계속 추가)

## 데이터 저장 (해당 시)
- 로그/결과물 저장 경로

## Required MCP (해당 시)
- playwright, ocr, paddleocr, send-file 등
```

## 작성 원칙

### description은 검색 키워드다
`skill_query`가 description을 가장 높은 가중치로 매칭함. 사용자가 쓸 법한 동의어·트리거 문구를 최대한 넣을 것.
- BAD: "이메일 관련 스킬"
- GOOD: "메일 확인, Gmail, 받은편지함, 이메일 읽기"

### Gotchas가 가장 가치 있는 섹션
- 처음엔 비어있어도 됨
- 실패할 때마다 하나씩 추가
- `skill_save`로 업데이트하면 기존 Gotchas가 자동 보존·merge됨
- "왜 실패했는지 + 어떻게 해결했는지" 쌍으로 기록

### 당연한 것은 쓰지 않는다
Claude가 이미 아는 것은 생략. 기본 행동에서 벗어나게 하는 정보에 집중.
- BAD: "파일을 저장한다"
- GOOD: "pandoc markdown 표는 글자 겹침 → CSS table로 HTML 변환 후 PDF"

### 스킬을 만들 타이밍
- 삽질 후 비자명한 해결책이 나왔을 때
- 동일 작업을 2번 이상 반복할 것 같을 때
- 복잡한 다단계 절차라 다음에 또 헤맬 것 같을 때
- 반대로 skip: 단순하고 누구나 아는 작업, 1회성 작업
