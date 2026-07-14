#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectStdio } from "#mcp/mcp-helpers";
import { errMsg } from "#platform/error";

const PYTHON = process.env.PADDLEOCR_PYTHON;
if (!PYTHON) {
  throw new Error(
    "PADDLEOCR_PYTHON not configured. Set PADDLEOCR_PYTHON in .env to your paddleocr venv python path. " +
      "See INSTALL.md section 5 for setup instructions.",
  );
}
const TIMEOUT_MS = Number.parseInt(process.env.PADDLEOCR_TIMEOUT_MS ?? "300000", 10);
const DET_LIMIT_SIDE_LEN = Number.parseInt(process.env.PADDLEOCR_DET_LIMIT_SIDE_LEN ?? "1280", 10);

const server = new McpServer({
  name: "paddleocr",
  version: "1.0.0",
});

const ALLOWED_LANGS = new Set([
  "korean",
  "ch",
  "en",
  "japan",
  "latin",
  "arabic",
  "cyrillic",
  "devanagari",
]);

// Inline Python script — runs in the venv, no temp file needed
function runPaddleOCR(filePath: string, lang: string): string {
  if (!ALLOWED_LANGS.has(lang)) {
    throw new Error(`Unsupported lang: "${lang}". Allowed: ${[...ALLOWED_LANGS].join(", ")}`);
  }
  const script = `
import sys, os
os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
import warnings, logging
warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

from paddleocr import PaddleOCR
ocr = PaddleOCR(
    lang="${lang}",
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    text_det_limit_side_len=${Number.isFinite(DET_LIMIT_SIDE_LEN) ? DET_LIMIT_SIDE_LEN : 1280},
    text_det_limit_type="max",
)
result = ocr.predict(sys.argv[1])
for res in result:
    for text in res.get("rec_texts", []):
        if text.strip():
            print(text.strip())
`.trim();

  return execFileSync(PYTHON!, ["-c", script, filePath], {
    encoding: "utf-8",
    timeout: Number.isFinite(TIMEOUT_MS) ? TIMEOUT_MS : 300000,
    env: {
      ...process.env,
      PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: "True",
    },
  }).trim();
}

// ── paddleocr_file ─────────────────────────────────────────────────────────
server.tool(
  "paddleocr_file",
  [
    "Extract text from an image using PaddleOCR (PP-OCRv5).",
    "Better than macOS Vision for Korean, Chinese, Japanese, and mixed-language documents.",
    "Supports: PNG, JPG, JPEG, WEBP, BMP, TIFF.",
    "Use lang='korean' for Korean docs, 'ch' for Chinese, 'en' for English-only.",
  ].join(" "),
  {
    file_path: z.string().describe("Absolute path to the image file"),
    lang: z
      .string()
      .optional()
      .default("korean")
      .describe("OCR language: 'korean' (default), 'ch' (Chinese/mixed), 'en', 'japan'"),
  },
  async ({ file_path, lang }) => {
    try {
      const absPath = resolve(file_path);
      const output = runPaddleOCR(absPath, lang ?? "korean");
      if (!output) {
        return { content: [{ type: "text", text: "No text found in the file." }] };
      }
      return { content: [{ type: "text", text: output }] };
    } catch (err: unknown) {
      return { content: [{ type: "text", text: `Error: ${errMsg(err)}` }], isError: true };
    }
  },
);

// ── main ───────────────────────────────────────────────────────────────────
await connectStdio(server);
