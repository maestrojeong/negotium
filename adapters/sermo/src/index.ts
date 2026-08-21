/**
 * Sermo — Voice AI Assistant adapter.
 *
 * Registers Sermo as a first-class Negotium channel adapter.
 * The VAD → STT → Brain → TTS loop runs in-process alongside
 * an embedded Negotium node.
 */

import { defineNegotiumAdapter, type NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import { isValidTranscription, transcribe } from "./stt";
import { speak } from "./tts";
import { DEFAULT_CONFIG, type SermoConfig, SermoState } from "./types";
import { startVad } from "./vad";

export type { SermoConfig, SermoState, Utterance } from "./types";
export { DEFAULT_CONFIG } from "./types";

// ── Adapter handle ───────────────────────────────────────────────────────

export interface SermoAdapterOptions {
  /** Negotium user ID for the Sermo user. */
  userId?: string;
  /** Negotium topic ID to send turns to. */
  topicId?: string;
  /** Override default config values. */
  config?: Partial<SermoConfig>;
}

export interface SermoAdapterHandle extends NegotiumAdapterHandle<"sermo"> {
  /** Settles when the voice loop stops (Ctrl+C or stop()). */
  readonly completed: Promise<void>;
}

// ── Brain (stub — TODO: wire to Negotium topic via submitUserMessage) ─────

async function askBrain(text: string): Promise<string> {
  process.stdout.write(`[sermo:brain] User said: "${text}"\n`);

  // Stub: echo with a short delay. Replace with submitUserMessage + runtimeBus.
  await delay(300);
  const response = `"${text}"라고 말씀하셨습니다.`;

  process.stdout.write(`[sermo:brain] Response: "${response}"\n`);
  return response;
}

// ── Main voice loop ──────────────────────────────────────────────────────

export function startSermoAdapter(options: SermoAdapterOptions = {}): SermoAdapterHandle {
  const config: SermoConfig = {
    ...DEFAULT_CONFIG,
    ...options.config,
    userId: options.userId ?? DEFAULT_CONFIG.userId,
    topicId: options.topicId ?? DEFAULT_CONFIG.topicId,
  };

  let state: SermoState = SermoState.Listening;
  let isSpeaking = false;
  let cleanupVad: (() => void) | null = null;
  let stopped = false;

  let resolveCompleted: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });

  async function processUtterance(filePath: string) {
    if (state !== SermoState.Transcribing) return;

    // ── Transcribe ───────────────────────────────────────────────────
    process.stdout.write("[sermo] Transcribing…\n");
    const text = await transcribe(filePath, config);

    if (!isValidTranscription(text)) {
      process.stdout.write(`[sermo] Discarded: "${text}" (too short/noise)\n`);
      state = SermoState.Listening;
      return;
    }

    process.stdout.write(`[sermo] STT → "${text}"\n`);

    // ── Think ────────────────────────────────────────────────────────
    state = SermoState.Thinking;
    const response = await askBrain(text);

    // ── Speak ────────────────────────────────────────────────────────
    state = SermoState.Speaking;
    isSpeaking = true;
    process.stdout.write("[sermo] Speaking…\n");

    try {
      await speak(response, config);
    } catch (err) {
      process.stderr.write(`[sermo:tts] Error: ${err}\n`);
    }

    // Post-TTS grace period
    await delay(config.postTtsGraceMs);
    isSpeaking = false;

    // ── Back to listening ────────────────────────────────────────────
    state = SermoState.Listening;
    process.stdout.write("[sermo] Listening…\n");
  }

  // ── Start VAD ─────────────────────────────────────────────────────────
  cleanupVad = startVad(config, {
    onSpeechStart() {
      if (isSpeaking || stopped) return;
      state = SermoState.Recording;
      process.stdout.write("[sermo] 🎤 Recording…\n");
    },

    onSpeechEnd() {
      if (isSpeaking || stopped) return;
      process.stdout.write("[sermo] 🔇 Silence — utterance complete\n");
    },

    onUtterance(utt) {
      if (isSpeaking || stopped) return;
      if (state !== SermoState.Recording) return;

      state = SermoState.Transcribing;
      process.stdout.write(
        `[sermo] Utterance: ${utt.durationSec.toFixed(1)}s, path: ${utt.filePath}\n`,
      );

      processUtterance(utt.filePath);
    },

    onStateChange(_recording: boolean) {
      // Reserved for future UI integration
    },
  });

  process.stdout.write("═══════════════════════════════════════\n");
  process.stdout.write("  Sermo — Voice AI Assistant\n");
  process.stdout.write("  Speak to begin. Press Ctrl+C to quit.\n");
  process.stdout.write("═══════════════════════════════════════\n");
  process.stdout.write("[sermo] Listening…\n");

  // Graceful shutdown on signals
  const onSignal = () => {
    process.stdout.write("\n[sermo] Shutting down…\n");
    stopped = true;
    cleanupVad?.();
    resolveCompleted();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return {
    name: "sermo",
    completed,
    async stop(): Promise<void> {
      stopped = true;
      cleanupVad?.();
      resolveCompleted();
      await completed;
    },
  };
}

// ── Declarative adapter registration ────────────────────────────────────

export const sermoAdapter = defineNegotiumAdapter({
  name: "sermo",
  capabilities: {
    localUserInput: true,
    topicManagement: true,
    externalPlacedTurn: false,
  },
  projection: {
    transcript: "full",
    historyBackfill: true,
    externalAuthors: "native",
  },
  start: startSermoAdapter,
});

// ── Helpers ──────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
