/**
 * Sermo — Voice AI Assistant adapter types.
 *
 * State machine: Listening → Recording → Transcribing → Thinking → Speaking
 */

/** Session-level state: what the assistant is doing right now. */
export enum SermoState {
  /** Waiting for speech onset — mic open, RMS monitored. */
  Listening = "listening",
  /** Speech detected, recording in progress. */
  Recording = "recording",
  /** Utterance complete — running STT. */
  Transcribing = "transcribing",
  /** Waiting for the brain (Negotium topic) to respond. */
  Thinking = "thinking",
  /** Playing TTS audio; mic frames are discarded. */
  Speaking = "speaking",
}

/** Configuration knobs. */
export interface SermoConfig {
  /** RMS floor for speech detection (absolute, tested on MacBook Pro mic). */
  rmsFloor: number;
  /** Silence duration in seconds before utterance is considered complete. */
  silenceTimeoutSec: number;
  /** Pre-padding seconds to retain before the first speech frame. */
  prePadSec: number;
  /** Minimum utterance duration in seconds — shorter clips are discarded. */
  minUtteranceSec: number;
  /** Post-TTS grace period in ms during which mic frames are still dropped. */
  postTtsGraceMs: number;
  /** Sample rate for recording (AVFoundation native). */
  sampleRate: number;
  /** Path to kokoro ONNX model. */
  kokoroModelPath: string;
  /** Path to kokoro voices file. */
  kokoroVoicesPath: string;
  /** Kokoro voice name for TTS. */
  ttsVoice: string;
  /** mlx-whisper model repo (e.g. "mlx-community/whisper-small"). */
  whisperModel: string;
  /** Whisper language code. */
  whisperLanguage: string;
  /** Negotium topic ID to send turns to. */
  topicId: string;
  /** Negotium user ID. */
  userId: string;
}

/** Default configuration — tweak per machine. */
export const DEFAULT_CONFIG: SermoConfig = {
  rmsFloor: 300,
  silenceTimeoutSec: 0.45,
  prePadSec: 0.2,
  minUtteranceSec: 0.8,
  postTtsGraceMs: 250,
  sampleRate: 48000,
  kokoroModelPath: "models/kokoro-v1.0.onnx",
  kokoroVoicesPath: "models/voices-v1.0.bin",
  ttsVoice: "af_kore",
  whisperModel: "mlx-community/whisper-small",
  whisperLanguage: "ko",
  topicId: "",
  userId: "sermo-user",
};

/** A raw utterance chunk captured by the VAD. */
export interface Utterance {
  /** Path to the WAV file. */
  filePath: string;
  /** Duration in seconds. */
  durationSec: number;
  /** When recording started (epoch ms). */
  startedAt: number;
}
