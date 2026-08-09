#!/usr/bin/env bun
/**
 * CLI entry point for the Sermo voice adapter.
 *
 * Used by `negotium sermo` to start the voice AI assistant.
 * Reads topic/user IDs from CLI args or environment.
 */

import { startSermoAdapter, type SermoAdapterHandle } from "./index";

export function runSermoCli(argv: string[], options?: { userId?: string; topicId?: string }): SermoAdapterHandle {
  // Read config from CLI args: --topic-id, --user-id, --rms-floor, etc.
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].replace(/^--/, "")] = argv[i + 1];
      i++;
    }
  }

  const config: Record<string, unknown> = {};
  if (args["rms-floor"]) config.rmsFloor = Number(args["rms-floor"]);
  if (args["silence-timeout"]) config.silenceTimeoutSec = Number(args["silence-timeout"]);
  if (args["whisper-model"]) config.whisperModel = args["whisper-model"];
  if (args["tts-voice"]) config.ttsVoice = args["tts-voice"];
  if (args["kokoro-model-path"]) config.kokoroModelPath = args["kokoro-model-path"];
  if (args["kokoro-voices-path"]) config.kokoroVoicesPath = args["kokoro-voices-path"];

  const handle = startSermoAdapter({
    userId: options?.userId ?? args["user-id"],
    topicId: options?.topicId ?? args["topic-id"],
    config: Object.keys(config).length > 0 ? config as any : undefined,
  });

  return handle;
}
