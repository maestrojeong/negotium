import { EFFORT_VALUES, getRegistry, type RuntimeBusEvent, type TopicDto } from "@negotium/core";
import type { NegotiumClient } from "@/client";
import { terminalNowMs } from "@/clock";
import type { CodeCopyTarget } from "@/render";
import { WORKING_FRAME_INTERVAL_MS } from "@/render";
import type { ScreenPoint } from "@/selection";
import { type AppState, activeTopic } from "@/state";

const MESSAGE_MUTATING_AI_STATUS_KINDS = new Set(["tool_call", "tool_output"]);
// biome-ignore lint/complexity/useRegexLiterals: avoids a literal terminal control byte in source.
const SGR_MOUSE_PATTERN = new RegExp("\\u001b\\[<(\\d+);(\\d+);(\\d+)([mM])", "g");
const TERMINAL_VAULT_USAGE =
  "Usage: /vault, /vault list, /vault set KEY VALUE [description], or /vault del KEY";

export function selectableEfforts(topic: TopicDto | null) {
  return topic?.agent ? getRegistry(topic.agent).validEfforts : EFFORT_VALUES;
}

export function maestroVaultKeyForModel(
  model: string,
): "DEEPSEEK_API_KEY" | "MOONSHOT_API_KEY" | null {
  if (model.startsWith("kimi")) return "MOONSHOT_API_KEY";
  if (model.startsWith("deepseek")) return "DEEPSEEK_API_KEY";
  return null;
}

export function vaultFormBlocksOverlaySwitch(
  state: Pick<AppState, "overlay" | "vaultMode">,
): boolean {
  return (
    state.overlay === "vault" && (state.vaultMode === "value" || state.vaultMode === "description")
  );
}

export type TerminalVaultCommandOutcome =
  | { kind: "open-manager" }
  | { kind: "notice"; notice: string };

export async function runTerminalVaultCommand(
  client: Pick<NegotiumClient, "runVaultCommand">,
  commandLine: string,
): Promise<TerminalVaultCommandOutcome> {
  const match = commandLine.trim().match(/^\/vault(?:@\w+)?(?:\s+([^\s]+))?/i);
  const subcommand = match?.[1]?.toLowerCase();

  if (!subcommand) return { kind: "open-manager" };
  if (subcommand !== "list" && subcommand !== "set" && subcommand !== "del") {
    return { kind: "notice", notice: TERMINAL_VAULT_USAGE };
  }
  if (!client.runVaultCommand) {
    return { kind: "notice", notice: "Vault commands are unavailable for this client." };
  }

  try {
    const output = await client.runVaultCommand(commandLine);
    return {
      kind: "notice",
      notice: output?.replace(/\s+/g, " ").trim() || "Vault command completed.",
    };
  } catch {
    return { kind: "notice", notice: "Vault command failed. Check the node connection." };
  }
}

export interface TerminalMouseEvent extends ScreenPoint {
  button: number;
  kind: "press" | "drag" | "release";
}

export function runtimeEventWaitsForMessageLoad(event: RuntimeBusEvent): boolean {
  if (event.type === "message" || event.type === "message-updated") return true;
  if (event.type !== "ai-status") return false;
  const payload = event.payload as { kind?: unknown } | null;
  return typeof payload?.kind === "string" && MESSAGE_MUTATING_AI_STATUS_KINDS.has(payload.kind);
}

export function runtimeEventInvalidatesSelection(
  state: Pick<AppState, "activeTopicId">,
  event: Pick<RuntimeBusEvent, "topicId">,
): boolean {
  return event.topicId === state.activeTopicId;
}

export function animationFrameAt(nowMs = terminalNowMs()): number {
  return Math.floor(nowMs / WORKING_FRAME_INTERVAL_MS);
}

export function consumeMouseInput(raw: string): {
  input: string;
  scrollDelta: number;
  events: TerminalMouseEvent[];
} {
  let scrollDelta = 0;
  const events: TerminalMouseEvent[] = [];
  const input = raw.replace(
    SGR_MOUSE_PATTERN,
    (_sequence, rawButton: string, rawX: string, rawY: string, suffix: string) => {
      const button = Number.parseInt(rawButton, 10);
      if (Number.isFinite(button) && (button & 64) !== 0) {
        scrollDelta += (button & 1) === 0 ? 3 : -3;
      } else {
        const x = Number.parseInt(rawX, 10);
        const y = Number.parseInt(rawY, 10);
        if (Number.isFinite(button) && Number.isFinite(x) && Number.isFinite(y)) {
          events.push({
            button,
            x,
            y,
            kind: suffix === "m" ? "release" : (button & 32) !== 0 ? "drag" : "press",
          });
        }
      }
      return "";
    },
  );
  return { input, scrollDelta, events };
}

export function codeCopyTargetAt(
  targets: CodeCopyTarget[],
  point: ScreenPoint,
): CodeCopyTarget | undefined {
  return targets.find(
    (target) => target.y === point.y && point.x >= target.xStart && point.x <= target.xEnd,
  );
}

export function escapeStopsActiveTurn(state: AppState): boolean {
  if (state.overlay || state.creatingTopic) return false;
  const topic = activeTopic(state);
  return Boolean(topic && state.activity[topic.id]?.running);
}

export function ctrlCExitsTopicPicker(state: AppState): boolean {
  return state.overlay === "topics";
}
