/**
 * VAD (Voice Activity Detection) — ffmpeg-based AVFoundation capture
 * with RMS thresholding, pre-padding, and utterance gating.
 *
 * Design:
 *   - RMS floor 300 (absolute, no AGC)
 *   - 0.45 s silence timeout
 *   - 0.2 s pre-padding
 *   - discard utterances < 0.8 s
 */

import { spawn, ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, renameSync, unlinkSync, WriteStream } from "node:fs";
import { join } from "node:path";
import { SermoConfig, Utterance } from "./types";

export interface VadEvents {
  onUtterance: (utt: Utterance) => void;
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onStateChange: (recording: boolean) => void;
}

/**
 * Start the VAD pipeline. Returns a cleanup function.
 *
 * We use a single persistent ffmpeg process that writes raw PCM to stdout.
 * Node.js reads the stream, computes RMS frame-by-frame, and gates utterances.
 */
export function startVad(config: SermoConfig, events: VadEvents): () => void {
  const recDir = join(process.cwd(), "recordings");
  mkdirSync(recDir, { recursive: true });

  // ── ffmpeg: AVFoundation → raw s16le PCM stdout ──────────────────────
  const ffmpeg = spawn("ffmpeg", [
    "-f", "avfoundation",
    "-i", ":1",                   // device 1 = MacBook Pro microphone
    "-ac", "1",                   // mono
    "-ar", String(config.sampleRate),
    "-f", "s16le",                // raw signed 16-bit little-endian
    "-c:a", "pcm_s16le",
    "-",                          // stdout
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const bytesPerSample = 2;       // s16le
  const bytesPerFrame = bytesPerSample; // mono
  const framesPerSec = config.sampleRate;
  const rmsWindowFrames = Math.floor(framesPerSec * 0.03); // ~30 ms windows

  // ── State ────────────────────────────────────────────────────────────
  let recording = false;
  let writeStream: WriteStream | null = null;
  let currentFilePath = "";
  let speechFrames = 0;
  let silenceFrames = 0;
  const silenceFrameThreshold = Math.floor(config.silenceTimeoutSec * framesPerSec / rmsWindowFrames);
  const minUtteranceFrames = Math.floor(config.minUtteranceSec * framesPerSec / rmsWindowFrames);
  const prePadFrames = Math.floor(config.prePadSec * framesPerSec / rmsWindowFrames);

  // Ring buffer for pre-padding
  const prePadBuffer: Buffer[] = [];
  let prePadCount = 0;

  // Accumulate partial reads
  let leftover: Buffer = Buffer.alloc(0);

  ffmpeg.stdout!.on("data", (chunk: Buffer) => {
    // Prepend any leftover bytes from the last read
    const data = leftover.length > 0
      ? Buffer.concat([leftover, chunk])
      : chunk;

    // How many complete frames we can consume
    const frameCount = Math.floor(data.length / bytesPerFrame);
    const consumed = frameCount * bytesPerFrame;
    leftover = data.subarray(consumed);

    // Process in RMS windows
    for (let i = 0; i + rmsWindowFrames * bytesPerFrame <= consumed; i += rmsWindowFrames * bytesPerFrame) {
      const window = data.subarray(i, i + rmsWindowFrames * bytesPerFrame);
      const rms = computeRms(window);

      const isSpeech = rms >= config.rmsFloor;

      // Pre-pad ring buffer
      if (!recording) {
        prePadBuffer.push(Buffer.from(window));
        if (prePadBuffer.length > prePadFrames) prePadBuffer.shift();
        prePadCount++;
      }

      if (isSpeech && !recording) {
        // ── Speech start ─────────────────────────────────────────────
        startRecording();
        // Flush pre-pad buffer
        for (const buf of prePadBuffer) {
          writeStream!.write(buf);
          speechFrames++;
        }
        prePadBuffer.length = 0;
        prePadCount = 0;
      }

      if (recording) {
        writeStream!.write(window);

        if (isSpeech) {
          speechFrames++;
          silenceFrames = 0;
        } else {
          silenceFrames++;
          if (silenceFrames >= silenceFrameThreshold) {
            stopRecording();
          }
        }
      }
    }
  });

  ffmpeg.stderr!.on("data", (_data: Buffer) => {
    // ffmpeg logs to stderr; suppress in normal operation.
  });

  ffmpeg.on("close", (code) => {
    if (recording) stopRecording();
    if (code !== 0 && code !== null) {
      process.stderr.write(`[sermo:vad] ffmpeg exited with code ${code}\n`);
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  function startRecording() {
    recording = true;
    speechFrames = 0;
    silenceFrames = 0;
    const ts = Date.now();
    currentFilePath = join(recDir, `utterance_${ts}.raw`);
    writeStream = createWriteStream(currentFilePath);
    events.onSpeechStart();
    events.onStateChange(true);
  }

  function stopRecording() {
    if (!recording || !writeStream) return;
    recording = false;
    writeStream.end();
    writeStream = null;

    const durationSec = (speechFrames * rmsWindowFrames) / framesPerSec;
    if (durationSec < config.minUtteranceSec) {
      // Too short — discard
      unlinkSync(currentFilePath);
      events.onStateChange(false);
      return;
    }

    // Convert raw PCM to WAV for mlx-whisper
    const wavPath = currentFilePath.replace(/\.raw$/, ".wav");
    convertToWav(currentFilePath, wavPath, config.sampleRate).then(() => {
      unlinkSync(currentFilePath); // clean up raw
      events.onUtterance({
        filePath: wavPath,
        durationSec,
        startedAt: Date.now(),
      });
    });

    events.onSpeechEnd();
    events.onStateChange(false);
  }

  return () => {
    ffmpeg.kill("SIGTERM");
    if (writeStream) {
      writeStream.end();
      writeStream = null;
    }
  };
}

/** Compute RMS of a 16-bit signed PCM window. */
function computeRms(buffer: Buffer): number {
  let sum = 0;
  const samples = buffer.length / 2;
  for (let i = 0; i < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

/** Convert raw s16le PCM to a WAV file with a proper header. */
async function convertToWav(rawPath: string, wavPath: string, sampleRate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-f", "s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-i", rawPath,
      "-acodec", "pcm_s16le",
      "-ar", "16000",  // resample to 16kHz for whisper
      "-y",
      wavPath,
    ], { stdio: "ignore" });
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg convert exited with ${code}`));
    });
  });
}
