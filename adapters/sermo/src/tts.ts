/**
 * TTS (Text-to-Speech) — kokoro-onnx via Python subprocess + afplay.
 *
 * Uses the free, local kokoro-onnx engine (ONNX runtime, ~310 MB model).
 * Korean voice: af_kore (one of 54 bundled voices).
 *
 * Output: 24 kHz WAV → played through macOS afplay.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SermoConfig } from "./types";

/**
 * Speak the given text using kokoro-onnx + afplay.
 * Resolves when playback has finished.
 */
export async function speak(
  text: string,
  config: SermoConfig,
): Promise<void> {
  if (!text || text.trim().length === 0) return;

  const outPath = join(tmpdir(), `sermo_tts_${Date.now()}.wav`);

  const script = [
    "import sys, soundfile as sf",
    "from kokoro_onnx import Kokoro",
    `text = sys.argv[1]`,
    `kokoro = Kokoro('${config.kokoroModelPath}', '${config.kokoroVoicesPath}')`,
    `samples, sr = kokoro.create(text, voice='${config.ttsVoice}', speed=1.0)`,
    `sf.write(sys.argv[2], samples, sr)`,
  ].join("; ");

  // ── Step 1: Synthesize ──────────────────────────────────────────────
  await new Promise<void>((resolve, reject) => {
    const py = spawn("python3", ["-c", script, text, outPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    py.stderr.on("data", (_chunk: Buffer) => {
      // Uncomment for debug: process.stderr.write(`[sermo:tts] ${chunk}`);
    });

    py.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`kokoro-onnx exited with code ${code}`));
    });

    py.on("error", reject);
  });

  // ── Step 2: Playback ────────────────────────────────────────────────
  await new Promise<void>((resolve, reject) => {
    const player = spawn("afplay", [outPath], {
      stdio: "ignore",
    });

    player.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`afplay exited with code ${code}`));
    });

    player.on("error", reject);
  });
}
