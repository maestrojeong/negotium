
## 디렉토리 구조
```
workspace/
├── CLAUDE.md                    # 이 문서 (프로젝트 컨텍스트)
├── topics/                      # 토픽별 작업 공간
│   └── {topicId}/
├── dm/                          # DM/온보딩 작업 공간
├── sessions/                    # 세션 제어 작업 공간
├── contexts/                    # 공유 컨텍스트 저장소
├── browser-profiles/            # 브라우저 자동화 프로필
├── tmp/                         # 임시 다운로드/캐시
├── wiki/                        # 공용 지식 베이스 (wiki 스킬로 관리)
│   ├── skills/                  # 재사용 가능한 스킬 정의
│   │   └── {skill-name}/
│   │       ├── skill.md         # 스킬 본문
│   │       └── scripts/        # 보조 스크립트 (해당 시)
│   ├── articles/                # 큐레이션된 개념 페이지
│   ├── summaries/               # 세션 요약 (wiki-archiver 자동 생성)
│   ├── topic/                   # 토픽 브리프 (세션 시작 시 주입)
│   ├── archive/                 # 세션 로그 아카이브
│   ├── article-index.md
│   ├── topic-index.md
│   └── skill-index.md
```
