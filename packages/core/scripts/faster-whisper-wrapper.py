#!/usr/bin/env python3
"""faster-whisper wrapper used by Otium media extraction.

Usage:
  faster-whisper-wrapper.py INPUT --model MODEL --language LANG --output-dir DIR --output-format txt

Arguments are the subset used by the TypeScript media extractor:
  --model          faster-whisper model size (e.g. medium, large-v3, turbo)
  --language       ISO language code (e.g. ko)
  --output-dir     Directory to write output files to
  --output-format  Output format (txt supported)

The script transcribes INPUT and writes {basename}.txt to --output-dir.
"""

from __future__ import annotations

import argparse
import os
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Audio file path")
    parser.add_argument("--model", default="medium", help="Whisper model size")
    parser.add_argument("--language", default=None, help="Language code (e.g. ko)")
    parser.add_argument("--output-dir", default=".", help="Output directory")
    parser.add_argument("--output-format", default="txt", help="Output format")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.output_format != "txt":
        print(f"Unsupported output format: {args.output_format}", file=sys.stderr)
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "faster-whisper not installed. Run: uv pip install faster-whisper",
            file=sys.stderr,
        )
        sys.exit(1)

    compute_type = "int8"  # CPU-friendly
    model_size = args.model
    # Normalize common model aliases to faster-whisper size identifiers.
    if "turbo" in model_size:
        model_size = "turbo"
    elif "large-v3" in model_size:
        model_size = "large-v3"
    elif "large-v2" in model_size:
        model_size = "large-v2"
    elif "medium" in model_size:
        model_size = "medium"
    elif "small" in model_size:
        model_size = "small"
    elif "tiny" in model_size:
        model_size = "tiny"

    os.makedirs(args.output_dir, exist_ok=True)

    model = WhisperModel(model_size, device="cpu", compute_type=compute_type)

    segments, info = model.transcribe(
        args.input,
        language=args.language,
        beam_size=5,
        vad_filter=True,
    )

    base = os.path.splitext(os.path.basename(args.input))[0]
    out_path = os.path.join(args.output_dir, f"{base}.txt")

    with open(out_path, "w", encoding="utf-8") as f:
        for segment in segments:
            f.write(segment.text.strip() + "\n")

    print(f"Transcription written to {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
