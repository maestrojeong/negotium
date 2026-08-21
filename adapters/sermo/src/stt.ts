/**
 * STT (Speech-to-Text) — mlx-whisper via Python subprocess.
 *
 * Uses Apple Silicon native Whisper inference through mlx-whisper.
 * Input: 16 kHz mono WAV.  Output: transcribed Korean text.
 *
 * Model selection: "mlx-community/whisper-small" is the recommended balance
 * for Korean on M-series (~91× realtime measured in production).
 */

import { spawn } from "node:child_process";
import type { SermoConfig } from "./types";

/**
 * Transcribe a WAV file to text using mlx-whisper.
 */
export async function transcribe(wavPath: string, config: SermoConfig): Promise<string> {
  return new Promise((resolve) => {
    const script = [
      "import sys, mlx_whisper",
      `result = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo='${config.whisperModel}', language='${config.whisperLanguage}')`,
      "print(result['text'].strip())",
    ].join("; ");

    const py = spawn("python3", ["-c", script, wavPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let text = "";
    py.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf-8");
    });

    py.stderr.on("data", (_chunk: Buffer) => {
      // mlx-whisper logs model loading progress to stderr
    });

    py.on("close", (code) => {
      if (code !== 0) {
        process.stderr.write(`[sermo:stt] python3 exited with code ${code}\n`);
      }
      resolve(text.trim());
    });

    py.on("error", (err) => {
      process.stderr.write(`[sermo:stt] failed to spawn python3: ${err.message}\n`);
      resolve("");
    });
  });
}

/**
 * Quick sanity filter for STT output. Discard edge cases that cause noise.
 */
export function isValidTranscription(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length <= 2) return false;
  if (/^[\s\p{P}]+$/u.test(trimmed)) return false;
  return true;
}
