# Document Conversion Skill

> **Description**: 문서 포맷 변환 요청 시 트리거. pandoc으로 md/docx/html 간 변환.

## pandoc

pandoc이 시스템에 설치되어 있어야 함 (`pandoc --version`으로 확인).

## 포맷 변환

```bash
# Markdown → Word
pandoc input.md -o output.docx

# Word → HTML
pandoc input.docx -o output.html

# Markdown → HTML
pandoc input.md -o output.html --standalone
```

## PDF 생성

PDF 생성이 필요하면 다음 방법 사용:

- **HTML → PDF**: Playwright (headless Chromium)로 HTML 페이지를 PDF로 인쇄. CSS `@page`로 여백·크기 제어.
- **Python PDF**: `reportlab` 또는 `fpdf2`로 프로그래밍 방식 생성
- **Markdown → PDF**: `pandoc input.md -o output.pdf --pdf-engine=weasyprint` (weasyprint 필요)

## 전송

PDF 생성 후 send_file 사용. 파일명 ASCII만.
