# TTS 텍스트→음성 변환 (Text-to-Speech)

> **Description**: "음성 만들어줘", "읽어줘", "TTS", "음성 파일로", "소리로 변환" 요청 시 트리거. edge-tts로 텍스트를 자연스러운 음성 MP3로 변환.

## 트리거
- 사용자가 텍스트를 음성으로 변환 요청 시
- "읽어줘", "음성으로 만들어줘" 등

## 프로세스

### 1. edge-tts로 MP3 생성
```bash
~/Library/Python/3.14/bin/edge-tts \
  --voice ko-KR-SunHiNeural \
  --text "변환할 텍스트" \
  --write-media ./tmp/tts_output.mp3
```

### 2. 파일 전송
- `mcp__send-file__send_file`로 전송
- `[FILE:/path/to/file.mp3]` 태그 포함

## 파일명 규칙
- 경로: 현재 Otium workspace의 `tmp/`
- 파일명: 내용을 영문으로 요약 (예: `meeting_summary.mp3`)
- 확장자: `.mp3`

## 음성 옵션

### 한국어 (기본: SunHi 여성)
| 음성 ID | 성별 | 용도 |
|---------|------|------|
| `ko-KR-SunHiNeural` | 여성 | **기본값**. 일반 안내, 요약 |
| `ko-KR-InJoonNeural` | 남성 | 남자 목소리 요청 시 |
| `ko-KR-HyunsuMultilingualNeural` | 남성 | 다국어 혼합 텍스트 |

### 영어
| 음성 ID | 성별 |
|---------|------|
| `en-US-JennyNeural` | 여성 |
| `en-US-GuyNeural` | 남성 |

### 속도/음높이/볼륨 조절
```bash
--rate "+20%"    # 빠르게 (-50% ~ +100%)
--rate "-10%"    # 느리게
--pitch "+5Hz"   # 높게
--volume "+50%"  # 크게
```

## 텍스트 작성 가이드
- 숫자는 한글로 풀어쓰기 (16,000원 → 만 육천원)
- 영어 약어는 풀어쓰거나 그대로 (edge-tts가 자동 처리)
- 긴 텍스트는 문장 사이에 마침표로 자연스러운 끊김
- 최대 길이 제한 없음 (로컬 실행, 무제한)

## Gotchas
- 인터넷 연결 필요 (Microsoft Edge TTS API 호출)
- 오프라인에서는 작동 안 함
- edge-tts 바이너리 경로: `~/Library/Python/3.14/bin/edge-tts`
- 한영 혼합 텍스트는 `HyunsuMultilingualNeural` 사용 권장
