# Browser Crash Recovery

> **Description**: 브라우저 에러 발생 시 트리거. "Failed to launch", "SIGKILL", "Target page closed", "SingletonLock" 등 에러 메시지가 나올 때 자동 적용.

## Required MCP
- playwright

## 증상
- `browser_evaluate` 또는 `browser_navigate` 호출 시 에러:
  - `Failed to launch the browser process`
  - `Opening in existing browser session` 후 종료
  - `Target page, context or browser has been closed`
  - `signal=SIGKILL` (kill 타이밍 충돌)
- `browser_navigate` 성공 후 바로 `browser_evaluate` 호출 시에도 크래시 (새 세션 시도하면서 충돌)

## 복구 절차 (순서대로)

### Step 1: 모든 Chrome 프로세스 강제 종료
```bash
pkill -9 -f "Google Chrome"
```
- `-9` (SIGKILL) 필수. 일반 `pkill -f`로는 안 죽는 경우 많음
- `"mcp-chrome-3d9e7cb"`만 타겟하면 남는 자식 프로세스 있음 → `"Google Chrome"` 전체 kill

### Step 2: 충분히 대기
```bash
sleep 2
```

### Step 3: Singleton 파일 전부 삭제
```bash
rm -f ~/Library/Caches/ms-playwright/mcp-chrome-3d9e7cb/SingletonLock
rm -f ~/Library/Caches/ms-playwright/mcp-chrome-3d9e7cb/SingletonSocket
rm -f ~/Library/Caches/ms-playwright/mcp-chrome-3d9e7cb/SingletonCookie
```
- SingletonLock만 지워서는 부족할 때 있음. **Singleton* 전부 삭제**

### Step 4: 프로세스 완전 종료 확인
```bash
ps aux | grep -E "mcp-chrome|Google Chrome" | grep -v grep | wc -l
```
- 반드시 `0`이어야 함. 0이 아니면 남은 PID를 직접 `kill -9`

### Step 5: 브라우저 재시작
```
browser_navigate → 원하는 URL
```
- 첫 시도에서 `Target page, context or browser has been closed` 에러가 날 수 있음
- 한 번 더 `browser_navigate` 호출하면 정상 작동

## 원스텝 명령어 (복사용)
```bash
pkill -9 -f "Google Chrome" 2>/dev/null; sleep 2; rm -f ~/Library/Caches/ms-playwright/mcp-chrome-3d9e7cb/Singleton*; ps aux | grep -E "mcp-chrome|Google Chrome" | grep -v grep | wc -l
```
→ 출력이 `0`이면 `browser_navigate`로 재시작

## 좀비 상태 (MCP 자동 재시작 루프)

### 증상
- kill 후에도 `ps aux`에 10+ Chrome 프로세스가 계속 나타남
- Singleton 파일 삭제해도 즉시 재생성
- `browser_close` → kill → navigate 해도 "Opening in existing browser session" 반복

### 원인
MCP Playwright 서버가 내부적으로 Chrome을 자동 재시작함. 서버가 Chrome 연결을 잃으면 새 Chrome을 띄우고, 우리가 kill하면 또 띄우는 무한 루프.

### 해결 순서
1. `browser_close` 호출 → MCP 측 세션 정리
2. 즉시 Chrome kill + Singleton 삭제
3. `browser_navigate` 시도
4. **그래도 안 되면 → 세션 재접속 필요** (MCP 서버 자체 재시작)

### 세션 재접속이 필요한 판단 기준
- 3회 이상 kill+clean+navigate 사이클 반복해도 해결 안 됨
- kill 직후 Chrome이 0.5초 내에 다시 뜸
- 사용자에게 "세션 재접속이 필요합니다" 안내

## 크래시 빈발 패턴 (예방)
- **Gmail 등 거대 DOM**: `browser_snapshot` 절대 금지 → `browser_evaluate`로 JS 실행하여 필요한 데이터만 추출
- **navigate → evaluate 연속 호출**: 세션 충돌 잘 일어남. navigate가 성공하면 바로 evaluate 가능하지만, 세션이 불안정할 때는 크래시
- **긴 setTimeout Promise**: 5초 이내로 유지 (오래 걸리면 세션 드롭 가능)
- **한 evaluate에서 최대한 많은 데이터 추출**: 호출 횟수 줄이기
- **about:blank 전환**: evaluate 중 페이지 전환 발생 → navigate로 원래 URL 재이동

## 주의사항
- 복구 후 **cron 작업이 소멸**될 수 있음 → `CronList`로 확인 필요
- `browser_evaluate` 실행 중 크래시 → page가 `about:blank`로 이동하는 패턴 있음
- 복구 실패 시 2~3회 반복하면 대부분 해결됨
- **좀비 상태에선 더 시도해도 시간 낭비** → 빠르게 세션 재접속 판단

## Gotchas
- `pkill -f "Google Chrome"` 시 사용자의 일반 Chrome도 같이 죽음 → 사전 안내 권장
- Singleton 파일 경로가 macOS 업데이트 시 변경될 수 있음 → `find ~ -name "SingletonLock" 2>/dev/null`로 확인
- 복구 후 Playwright MCP가 새 브라우저를 열면 이전 로그인 세션이 유지됨 (쿠키 보존)
- 크론 작업(CronCreate)은 세션 기반이라 복구 시 소멸 → `CronList`로 반드시 확인
