# 동영상 이해 스킬

> **Description**: 동영상 파일 분석 요청 시 트리거. 텔레그램 영상 첨부, "영상 분석", "동영상 요약" 등 요청 시 적용. 2-pass 방식(음성→프레임).

## Required MCP
- send-file

## 개요
동영상을 2-pass로 분석: 먼저 음성으로 내용 파악 → 핵심 장면 타이밍에 프레임 추출.

## 전제
- 텔레그램으로 동영상 첨부 시, 봇이 자동으로 썸네일 1장 + 영상 경로 + 분석용 디렉토리를 제공함
- 프롬프트에 `video-understanding 스킬을 참고하여 분석해주세요` 라는 안내가 포함됨
- 이 스킬을 따라 단계별로 진행할 것

## Pass 1: 음성 텍스트 확보

### 1-1. faster-whisper로 음성 변환
```bash
# 음성 추출
ffmpeg -y -i "영상경로" -vn -acodec libmp3lame -q:a 4 -ac 1 -ar 16000 "분석디렉토리/audio.mp3"

# faster-whisper wrapper로 변환 (기본 모델: turbo)
python3 "apps/runtime-api/scripts/faster-whisper-wrapper.py" "분석디렉토리/audio.mp3" --model turbo --language ko --output-dir "분석디렉토리" --output-format txt
```
- `PYTHON_BIN`, `FASTER_WHISPER_WRAPPER`, `WHISPER_MODEL_FILE`이 설정돼 있으면 그 값을 우선 사용
- 긴 영상은 `background-bash`로 실행 권장
- whisper-transcribe.md 참조

### 1-2. 텍스트 문맥 교정 (선택)
- faster-whisper 결과 txt 파일 읽기
- 도메인 특화 고유명사가 있으면 보완 (예: 의료/법률 전문용어)
- 화자 구분 추론 (가능한 경우)
- **타임스탬프 포함된 구간 파악** → Pass 2에서 사용

### 1-3. 핵심 장면 타이밍 결정
교정된 텍스트를 기반으로 프레임을 추출할 타이밍 선정:
- **장면 전환점**: 주제가 바뀌는 시점
- **핵심 언급 시점**: 중요 정보가 나오는 순간
- **시각 정보 필요 시점**: "이것 보세요", "화면에..." 등 시각적 참조
- 2~5개 타이밍 선정 (영상 길이에 비례)

## Pass 2: 핵심 장면 프레임 추출

### 2-1. 선정된 타이밍에 프레임 추출
```bash
# 각 타이밍(초)마다 실행
ffmpeg -y -ss {초} -i "영상경로" -vframes 1 -q:v 2 "분석디렉토리/scene_{N}.jpg"
```

### 2-2. 프레임 이미지 분석
- 각 프레임을 읽고 시각적 내용 파악
- 텍스트와 대조: 음성에서 언급된 내용이 화면에 있는지 확인
- 자막, UI, 슬라이드 등 텍스트 요소 읽기

## 종합 분석

프레임(시각) + 교정된 텍스트(음성)를 종합하여:
1. 영상 내용 이해
2. 사용자 질문에 답변

### 응답 예시
```
📹 영상 분석 (1분 30초)

**내용**: (한 줄 요약)

**음성 내용**:
(교정된 텍스트 요약)

**주요 장면**:
- 0:12 - (장면 설명)
- 0:45 - (장면 설명)
```

## 도구 경로
- ffmpeg: `FFMPEG_BIN` 또는 PATH의 `ffmpeg`
- ffprobe: `FFPROBE_BIN` 또는 PATH의 `ffprobe`
- faster-whisper wrapper: `FASTER_WHISPER_WRAPPER` 또는 `apps/runtime-api/scripts/faster-whisper-wrapper.py`
- Python: `PYTHON_BIN` 또는 PATH의 `python3`

## 제한사항
- 전사 품질과 속도는 선택한 faster-whisper model size와 CPU/GPU 환경에 의존
- 프레임은 정지 이미지 — 움직임/동작은 음성 텍스트로 보완

## Gotchas
- 프레임 추출 시 `-q:v 2` 필수 (기본값은 화질 낮음)
- 30분+ 영상은 `background-bash`로 실행
- ffmpeg `-ss` 옵션은 `-i` 앞에 넣어야 정확한 타이밍 (뒤에 넣으면 키프레임 기준)
- 음성이 없는 영상도 있음 → 전사 결과가 비어있으면 프레임 분석만으로 진행
