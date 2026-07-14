import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type {
  HookInput,
  Options,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKTaskStartedMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ContentBlockParam,
  ImageBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { claudeRegistry } from "#agents/claude-registry";
import { deepMapStrings } from "#agents/deep-map";
import {
  referencesRuntimeSecretStorage,
  shouldRedirectVaultTool,
  VAULT_BROKER_REDIRECT_ERROR,
} from "#agents/vault-tool-policy";
import { extractFileEvents } from "#media/file-events";
import { CLAUDE_EXECUTABLE } from "#platform/config";
import { errMsg } from "#platform/error";
import { logger } from "#platform/logger";
import { getMcpServersForQuery } from "#platform/mcp-config";
import { redactVaultSecrets } from "#storage/vault";
import type { AgentInputAttachment, AgentQueryOptions, EffortLevel, UnifiedEvent } from "#types";

const CLAUDE_DEFAULT_DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
] as const;

const CLAUDE_NATIVE_AGENT_TOOLS = ["Task", "Agent", "TaskOutput", "TaskStop"] as const;

export function buildClaudeDisallowedTools(
  extra: readonly string[] | undefined = undefined,
  opts: { allowNativeAgents?: boolean } = {},
): string[] {
  return [
    ...new Set([
      ...CLAUDE_DEFAULT_DISALLOWED_TOOLS,
      ...(opts.allowNativeAgents ? [] : CLAUDE_NATIVE_AGENT_TOOLS),
      ...(extra ?? []),
    ]),
  ];
}

/**
 * Narrow our shared `EffortLevel` to the subset claude-agent-sdk accepts.
 * Claude SDK rejects "minimal" (codex-only); we drop it silently rather than
 * coercing, matching our policy for unrecognized model strings.
 */
type ClaudeEffort = Exclude<EffortLevel, "minimal">;
function toClaudeEffort(e: EffortLevel | undefined): ClaudeEffort | undefined {
  if (!e || !claudeRegistry.validateEffort(e)) return undefined;
  return e as ClaudeEffort;
}

type ClaudeImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const CLAUDE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CLAUDE_IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isClaudeImageAttachment(
  attachment: AgentInputAttachment,
): attachment is AgentInputAttachment & { mimeType: ClaudeImageMimeType } {
  return attachment.type === "image" && CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType);
}

async function* singleUserMessage(message: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
  yield message;
}

function buildClaudePrompt(opts: AgentQueryOptions): string | AsyncIterable<SDKUserMessage> {
  const attachments = opts.attachments ?? [];
  if (attachments.length === 0) return opts.prompt;

  const imageBlocks: ImageBlockParam[] = [];
  for (const attachment of attachments) {
    if (!isClaudeImageAttachment(attachment)) continue;
    if (attachment.sizeBytes > CLAUDE_IMAGE_MAX_BYTES) {
      logger.info(
        {
          path: attachment.path,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          maxBytes: CLAUDE_IMAGE_MAX_BYTES,
        },
        "claudeProvider: skipping oversized image attachment content block",
      );
      continue;
    }

    try {
      imageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: readFileSync(attachment.path).toString("base64"),
        },
      });
    } catch (err) {
      logger.warn(
        {
          path: attachment.path,
          mimeType: attachment.mimeType,
          err,
        },
        "claudeProvider: failed to read image attachment for content block",
      );
    }
  }

  if (imageBlocks.length === 0) return opts.prompt;

  const content: ContentBlockParam[] = [{ type: "text", text: opts.prompt }, ...imageBlocks];
  return singleUserMessage({
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
  });
}

// --- Stream event sub-types (from @anthropic-ai/sdk, not directly importable) ---
interface ContentBlockDelta {
  type: "content_block_delta";
  delta: { type: string; partial_json?: string; text?: string };
}
type StreamEvent = ContentBlockDelta | { type: string };

// --- Assistant message content block types (from BetaMessage.content) ---
interface TextBlock {
  type: "text";
  text: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown;
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string };

// --- Process tree kill on abort ---
//
// The Claude Agent SDK spawns a `claude` CLI subprocess, which in turn spawns
// MCP servers (playwright-mcp, python OCR servers, …) which themselves spawn
// browsers / interpreters. The SDK's default abort path only signals the
// direct child, leaving grandchildren orphaned — over time they accumulate as
// zombies, holding ports (Playwright DevTools 9222) and leaking memory
// (Chrome ~hundreds of MB per orphan). Single-user Mac deployments notice
// this within a day of repeated /abort.
//
// We override `spawnClaudeCodeProcess` to:
//   1. spawn with `detached: true` → child becomes the leader of a new
//      process group with the same pgid as its pid;
//   2. on abort, send the signal to `-pid` (the whole group) instead of the
//      single pid, so all transitive descendants receive it;
//   3. escalate to SIGKILL after a 2.5s grace if SIGTERM didn't take.

type SpawnClaudeCodeProcess = NonNullable<Options["spawnClaudeCodeProcess"]>;
type SpawnClaudeCodeOptions = Parameters<SpawnClaudeCodeProcess>[0];
type SpawnClaudeCodeResult = ReturnType<SpawnClaudeCodeProcess>;

const CLAUDE_ABORT_SIGKILL_DELAY_MS = 2500;

function signalProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  // Negative pid = "signal every process in this process group". Falls back
  // to single-pid signaling if the group call fails (e.g. on platforms where
  // `detached` didn't materialize a new group).
  try {
    process.kill(-pid, signal);
    return true;
  } catch (groupErr) {
    try {
      process.kill(pid, signal);
      return true;
    } catch (pidErr) {
      logger.debug({ groupErr, pidErr, pid, signal }, "Failed to signal Claude process tree");
      return false;
    }
  }
}

export function spawnClaudeCodeProcessWithTreeKill(
  options: SpawnClaudeCodeOptions,
): SpawnClaudeCodeResult {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: true,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (!child.stdin || !child.stdout) {
    child.kill("SIGKILL");
    throw new Error("Failed to spawn Claude Code process with piped stdin/stdout");
  }

  let exited = false;
  let killTimer: NodeJS.Timeout | undefined;
  const clearKillTimer = () => {
    if (killTimer) clearTimeout(killTimer);
    killTimer = undefined;
  };

  const kill = (signal: NodeJS.Signals): boolean => {
    if (!child.pid) return child.kill(signal);
    const ok = signalProcessTree(child.pid, signal);
    if (signal !== "SIGKILL") {
      // Soft signal: schedule a SIGKILL fallback so a stuck process tree
      // can't survive abort indefinitely.
      clearKillTimer();
      killTimer = setTimeout(() => {
        if (!exited && child.pid) {
          logger.warn({ pid: child.pid }, "Claude process tree still alive after SIGTERM; SIGKILL");
          signalProcessTree(child.pid, "SIGKILL");
        }
      }, CLAUDE_ABORT_SIGKILL_DELAY_MS);
      killTimer.unref?.();
    }
    return ok;
  };

  const onAbort = () => {
    logger.warn({ pid: child.pid, command: options.command }, "Aborting Claude Code process tree");
    kill("SIGTERM");
  };

  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener("abort", onAbort, { once: true });

  child.once("exit", (code, signal) => {
    exited = true;
    clearKillTimer();
    options.signal.removeEventListener("abort", onAbort);
    logger.debug({ pid: child.pid, code, signal }, "Claude Code process exited");
  });

  // Consume the child's 'error' event. Without a listener, a spawn-level error
  // propagates into the SDK's readline-over-stdout teardown and crashes the
  // whole process with "this.input.pause is not a function" (node:readline
  // close→pause on a stream that never initialized). Handling it here keeps the
  // failure local and surfaces a clean diagnostic.
  child.once("error", (err) => {
    exited = true;
    clearKillTimer();
    options.signal.removeEventListener("abort", onAbort);
    logger.error(
      {
        pid: child.pid,
        command: options.command,
        err: err instanceof Error ? err.message : String(err),
      },
      "Claude Code process error event",
    );
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed || exited;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill,
    on(event, listener) {
      child.on(event, listener);
    },
    once(event, listener) {
      child.once(event, listener);
    },
    off(event, listener) {
      child.off(event, listener);
    },
  };
}

/**
 * Recognize the multiple shapes Node + WHATWG fetch use when a request is
 * cancelled via `AbortController`. Mirrors `isAbortError` in maestro/provider
 * — both files keep their own copy so neither has to import the other (the
 * agent providers are deliberately siblings, no shared error helpers).
 */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name === "AbortError") return true;
  if (e.code === 20 || e.code === "ABORT_ERR") return true;
  return false;
}

/**
 * Core Claude provider.
 * Wraps the @anthropic-ai/claude-agent-sdk into a UnifiedEvent stream so any
 * caller can consume it identically to other providers such as codexProvider.
 * The dispatch entry point is `runAgent` in agents/index.ts.
 *
 * Failure handling: any throw escaping the SDK iteration (missing Claude CLI
 * binary, OAuth not configured, transient network) is caught and yielded as
 * a `{type:"error"}` UnifiedEvent so the dispatcher never sees a synthetic
 * crash and event-processor's `error` case classifies it with the right
 * provider name. Matches the graceful pattern maestroProvider already uses.
 * Abort signals are swallowed silently (the user moved on) so they don't
 * surface as ghost error messages.
 */
export async function* claudeProvider(opts: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  // Up-front existence check — gives the user a clean, actionable error
  // instead of waiting for the SDK to spawn the binary and fail mid-stream
  // with an opaque ENOENT. The SDK's own resolution path runs after spawn,
  // so if CLAUDE_EXECUTABLE points nowhere we want to surface it now.
  if (!existsSync(CLAUDE_EXECUTABLE)) {
    yield {
      type: "error",
      content: `Claude CLI not found at ${CLAUDE_EXECUTABLE}. Install Claude Code or set CLAUDE_EXECUTABLE.`,
    };
    return;
  }

  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  cleanEnv.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT ??= process.env.PADDLEOCR_TIMEOUT_MS ?? "300000";
  // Workflow is a feature flag, not a disallowedTools-addressable tool name.
  // The env var is the version-robust kill switch (works on any CLI the SDK
  // spawns); the `settings` flag layer below covers it a second time.
  cleanEnv.CLAUDE_CODE_DISABLE_WORKFLOWS = "1";

  const queryOptions: Options = {
    pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE,
    spawnClaudeCodeProcess: spawnClaudeCodeProcessWithTreeKill,
    cwd: opts.cwd,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    env: cleanEnv,
    mcpServers: getMcpServersForQuery(opts) as Options["mcpServers"],
    abortController: opts.abortController,
    // `AskUserQuestion` is Claude Code's built-in clarification tool, but it
    // expects the SDK CLI to render a TUI prompt and read stdin for the
    // answer — neither exists in this headless Telegram bridge. Without
    // disallowing it, the model would call AskUserQuestion, the SDK would
    // wait for a TUI response that never comes, and the turn would hang
    // until abort. Forbidding the tool nudges the model to ask the same
    // clarification as plain text (see topic-system prompt), which routes
    // through the normal next-user-message path and the user just answers
    // in the topic.
    //
    // Claude Code's private task store and native subagent tools are not Otium
    // task state. Use the shared `task` MCP server so the same task list
    // survives switching between claude, codex, and maestro. When callers pass
    // explicit custom agents, preserve that existing SDK path.
    disallowedTools: buildClaudeDisallowedTools(opts.disallowedTools, {
      allowNativeAgents: Boolean(opts.agents),
    }),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.agents
      ? {
          agents: Object.fromEntries(
            Object.entries(opts.agents).map(([name, def]) => {
              const { effort, ...rest } = def;
              const narrowed = typeof effort === "string" ? toClaudeEffort(effort) : effort;
              return [name, narrowed !== undefined ? { ...rest, effort: narrowed } : rest];
            }),
          ),
        }
      : {}),
    ...(toClaudeEffort(opts.effort) ? { effort: toClaudeEffort(opts.effort) } : {}),
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input: HookInput) => {
              const { tool_name, tool_input } = input as PreToolUseHookInput;
              if (referencesRuntimeSecretStorage(tool_input)) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: "Runtime secret storage access is not permitted",
                  },
                };
              }

              // Block built-in run_in_background: the bash runs inside the CLI
              // subprocess and dies when the turn ends (SIGTERM on IPC close).
              // Direct the model to the MCP tool that survives across turns and
              // auto-injects a completion notification via session-inbox.
              if (
                tool_name === "Bash" &&
                (tool_input as Record<string, unknown>)?.run_in_background === true
              ) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason:
                      "run_in_background is not supported in headless mode — the bash process dies when the agent turn ends. Use mcp__background-bash__background_bash_run instead: it survives across turns and automatically injects the result into the session when done.",
                  },
                };
              }

              // Detect real Vault placeholders but never inject plaintext into
              // provider-visible tool input. The Vault MCP broker expands them.
              const userId = opts.userId ?? "";
              if (!shouldRedirectVaultTool(userId, tool_name, tool_input)) {
                return { continue: true };
              }
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: VAULT_BROKER_REDIRECT_ERROR,
                },
              };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input: HookInput) => {
              const { tool_response } = input as PostToolUseHookInput;
              const userId = opts.userId ?? "";
              const redacted = deepMapStrings(tool_response, (value) =>
                redactVaultSecrets(userId, value),
              );
              if (JSON.stringify(redacted) === JSON.stringify(tool_response)) {
                return { continue: true };
              }
              return {
                hookSpecificOutput: {
                  hookEventName: "PostToolUse" as const,
                  updatedToolOutput: redacted,
                },
              };
            },
          ],
        },
      ],
    },
    settingSources: ["project"] as Options["settingSources"],
    // Disable the multi-agent Workflow feature: a headless backend query has
    // no business fanning out orchestration subagents, and the "ultracode"
    // keyword trigger would let user-authored message text opt into it.
    settings: {
      disableWorkflows: true,
      workflowKeywordTriggerEnabled: false,
    },
    systemPrompt: opts.systemPrompt,
  };

  if (opts.sessionId) {
    queryOptions.resume = opts.sessionId;
  }

  // Wrap the SDK iteration so init failures (missing claude CLI, OAuth not
  // configured, transient network errors before the first event) surface as
  // a normal error UnifiedEvent. Without this, an unconfigured Claude
  // install would crash the dispatcher with a synthetic exception and the
  // user-facing classifyError would still fire — but only via the handler
  // catch path, which means cleanup ordering differed from maestro/codex.
  // Keeping the failure shape consistent across providers simplifies the
  // upstream error code.
  // Thinking heartbeat: long extended-thinking stretches (minutes on fable /
  // high effort) emit no text or tool events, so the room UI goes silent and
  // the user can't tell whether the turn is still alive. The SDK does stream
  // thinking signals (`thinking_delta` content deltas, `system/thinking_tokens`
  // pings during redacted thinking) — digest them into a throttled
  // `tool_progress` heartbeat that the client already renders as a live status
  // chip (its handler also re-asserts the typing indicator).
  const THINKING_BEAT_MS = 5000;
  let thinkingStart: number | null = null;
  let lastThinkingBeat = 0;
  const thinkingBeat = (): { type: "tool_progress"; toolName: string; elapsed: number } | null => {
    const now = Date.now();
    if (thinkingStart === null) {
      thinkingStart = now;
      lastThinkingBeat = now;
      return { type: "tool_progress", toolName: "thinking", elapsed: 0 };
    }
    if (now - lastThinkingBeat < THINKING_BEAT_MS) return null;
    lastThinkingBeat = now;
    return { type: "tool_progress", toolName: "thinking", elapsed: (now - thinkingStart) / 1000 };
  };

  try {
    const prompt = buildClaudePrompt(opts);
    for await (const message of query({
      prompt,
      options: queryOptions,
    })) {
      // --- Thinking heartbeat (see above) ---
      // A thinking "stretch" ends at the first non-thinking signal so elapsed
      // restarts cleanly on the next thinking phase within the same turn.
      if (
        message.type === "system" &&
        (message as { subtype?: string }).subtype === "thinking_tokens"
      ) {
        const beat = thinkingBeat();
        if (beat) yield beat;
        continue;
      }

      // --- Stream events (token-by-token) ---
      // tool_use is NOT emitted from the stream path: the completed assistant
      // message below carries the same block with its input already parsed,
      // and tools only start executing after the message completes — so the
      // stream copy added no timeliness, only a duplicate tool_use per turn
      // in the unified log (doubling `<!-- Tool: ... -->` comments when
      // bridging to another agent).
      if (message.type === "stream_event") {
        const streamMsg = message as SDKPartialAssistantMessage;
        const evt = (streamMsg as { event?: StreamEvent }).event;
        if (!evt) continue;

        if (evt.type === "content_block_delta") {
          const delta = evt as ContentBlockDelta;
          if (delta.delta.type === "thinking_delta") {
            const beat = thinkingBeat();
            if (beat) yield beat;
          } else if (delta.delta.type === "text_delta" && delta.delta.text) {
            thinkingStart = null;
            yield { type: "text_delta", content: delta.delta.text };
          } else {
            // Tool-args streaming (partial_json) etc. — thinking stretch over.
            thinkingStart = null;
          }
        }

        continue;
      }

      // Any completed message (assistant text, tool events, results) ends the
      // current thinking stretch.
      thinkingStart = null;

      // --- Tool progress ---
      if (message.type === "tool_progress") {
        const m = message as SDKToolProgressMessage;
        yield {
          type: "tool_progress",
          toolName: m.tool_name,
          elapsed: m.elapsed_time_seconds,
        };
        continue;
      }

      // --- Tool use summary ---
      if (message.type === "tool_use_summary") {
        const m = message as SDKToolUseSummaryMessage;
        yield { type: "tool_use_summary", summary: m.summary };
        continue;
      }

      // --- System init ---
      if (message.type === "system") {
        const m = message as SDKSystemMessage;
        if (m.subtype === "init") {
          yield { type: "session", sessionId: m.session_id };
        } else if (m.subtype === "task_started") {
          const t = m as unknown as SDKTaskStartedMessage;
          if (t.subagent_type && !t.skip_transcript) {
            const desc = t.description ? ` ${t.description.slice(0, 60)}` : "";
            yield { type: "status", content: `▶ [${t.subagent_type}]${desc}` };
          }
        } else {
          // Log all other system messages (task_updated, task_progress,
          // task_notification, etc.) so we can observe lifecycle events.
          logger.debug(
            { subtype: m.subtype, msg: m },
            "claudeProvider: system message (unhandled subtype)",
          );
        }
        continue;
      }

      // --- Result (terminal) ---
      // SDK occasionally yields stray messages after a `result`; consuming them
      // surfaces as ghost messages in the topic ("어? 뭐가 더 나오네?"). Close
      // the generator immediately on terminal so the SDK stream is dropped and
      // any trailing payloads can't leak through.
      if (message.type === "result") {
        const m = message as SDKResultMessage;
        if (m.subtype === "success") {
          yield {
            type: "result",
            content: m.result,
            stopReason: m.stop_reason ?? "end_turn",
            usage: m.usage
              ? {
                  inputTokens: m.usage.input_tokens,
                  outputTokens: m.usage.output_tokens,
                  cacheCreationInputTokens: m.usage.cache_creation_input_tokens ?? undefined,
                  cacheReadInputTokens: m.usage.cache_read_input_tokens ?? undefined,
                }
              : undefined,
          };
          yield* extractFileEvents(m.result, "result");
          return;
        }
        // Error result
        const errorMsg = m.errors?.join("; ") || "Unknown error";
        yield { type: "error", content: errorMsg };
        return;
      }

      // --- Assistant message ---
      if (message.type === "assistant") {
        const m = message as SDKAssistantMessage;
        const content = (m.message?.content ?? []) as ContentBlock[];

        for (const block of content) {
          if (block.type === "text") {
            const textBlock = block as TextBlock;
            yield { type: "text", content: textBlock.text };
            // Surface mid-turn [FILE:/abs/path] tags right away, matching codex/
            // maestro providers — without this, a model that narrates a file
            // before its next tool call (rather than emitting the tag in the
            // final `result` text) wouldn't trigger send-file at all. The file
            // event handler dedups on normalized path so the same tag appearing
            // again in `result` won't double-send.
            yield* extractFileEvents(textBlock.text, "text");
          } else if (block.type === "tool_use") {
            const tb = block as ToolUseBlock;
            yield {
              type: "tool_use",
              name: tb.name,
              input: tb.input || {},
              toolUseId: tb.id,
            };
          }
        }
        continue;
      }

      // --- User message (tool results ride on user-role messages) ---
      // The Anthropic message protocol puts tool_result blocks in USER
      // messages, never assistant ones — without this branch the unified log
      // records tool calls but no results, losing information codex topics
      // keep (visible when bridging a claude topic to another agent).
      if (message.type === "user") {
        const um = message as SDKUserMessage | SDKUserMessageReplay;
        // Replays re-deliver transcript history on resume; mapping them would
        // duplicate every past tool_result into the unified log.
        if ("isReplay" in um && um.isReplay) continue;
        const content = um.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as ContentBlock[]) {
          if (block.type !== "tool_result") continue;
          const trBlock = block as ToolResultBlock;
          const trContent =
            typeof trBlock.content === "string" ? trBlock.content.slice(0, 200) : "";
          yield {
            type: "tool_result",
            toolUseId: trBlock.tool_use_id || "",
            content: trContent,
          };
        }
      }
    }
  } catch (e) {
    // Abort = user moved on; don't surface as an error message. The handler
    // catches the abort signal separately via abortReason, so swallowing
    // here matches both maestro and codex behavior.
    if (isAbortError(e) || opts.abortController?.signal.aborted) return;
    logger.error({ err: e }, "claudeProvider: SDK iteration failed");
    yield { type: "error", content: errMsg(e) };
  }
}
