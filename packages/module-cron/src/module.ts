import { fileURLToPath } from "node:url";
import {
  buildStdioMcpServer,
  cancelDeferredInject,
  getTopic,
  logger,
  type NegotiumNodeModule,
  registerBackgroundSessionProvider,
  registerRuntimeMcpServer,
  resolveTopicWorkspaceDir,
  triggerTopicAiTurn,
} from "@negotium/core";
import { listCronBackgroundSessions } from "#background-sessions";
import { resetCronTopicContext } from "#context";
import { CronScheduler, type CronSchedulerOptions } from "#scheduler";
import { runCronPromptScript } from "#scripts";
import { ensureCronSchema, listOrphanedCronTopicSessions } from "#store";

const MCP_SERVER_FILE = fileURLToPath(new URL("./mcp-server.ts", import.meta.url));

export interface CronModuleOptions {
  pollIntervalMs?: number;
  runTimeoutMs?: number;
  queueTimeoutMs?: number;
  scriptTimeoutMs?: number;
}

function envMs(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createCronModule(options: CronModuleOptions = {}): NegotiumNodeModule {
  return {
    name: "cron",
    singleton: true,
    capabilities: ["scheduler.cron.v1", "scheduler.cron.v2"],
    start(context) {
      ensureCronSchema();
      const cleanupTasks = new Set<Promise<unknown>>();
      const trackCleanup = (promise: Promise<unknown>) => {
        cleanupTasks.add(promise);
        void promise.then(
          () => cleanupTasks.delete(promise),
          (error) => {
            cleanupTasks.delete(promise);
            logger.warn({ err: error }, "cron: topic context cleanup failed");
          },
        );
      };
      for (const topicId of new Set(
        listOrphanedCronTopicSessions().map((entry) => entry.topicId),
      )) {
        trackCleanup(resetCronTopicContext(topicId));
      }
      const unsubscribeTopicCleanup = context.bus.subscribe((event) => {
        if (event.type === "topic-deleted") trackCleanup(resetCronTopicContext(event.topicId));
      });
      const unregisterMcp = registerRuntimeMcpServer("cron-manager", {
        scopes: ["forum", "manager"],
        forumRequired: true,
        build({ userId, session, topicId, agent }) {
          const args = [`--user-id=${userId}`, `--topic=${session}`];
          if (topicId) args.push(`--topic-id=${topicId}`);
          return buildStdioMcpServer(agent, MCP_SERVER_FILE, args);
        },
      });
      const unregisterBackgroundSessions = registerBackgroundSessionProvider(
        listCronBackgroundSessions,
      );

      const schedulerOptions: CronSchedulerOptions = {
        bus: context.bus,
        pollIntervalMs: options.pollIntervalMs ?? envMs("NEGOTIUM_CRON_POLL_INTERVAL_MS", 1_000),
        runTimeoutMs: options.runTimeoutMs ?? envMs("NEGOTIUM_CRON_RUN_TIMEOUT_MS", 10 * 60_000),
        queueTimeoutMs:
          options.queueTimeoutMs ?? envMs("NEGOTIUM_CRON_QUEUE_TIMEOUT_MS", 5 * 60_000),
        async dispatch(job, run, hooks, execution) {
          const taskPrompt =
            job.prompt ??
            (await runCronPromptScript({
              script: job.script!,
              cwd: resolveTopicWorkspaceDir(job.topicId),
              jobId: job.id,
              topicId: job.topicId,
              timeoutMs:
                options.scriptTimeoutMs ?? envMs("NEGOTIUM_CRON_SCRIPT_TIMEOUT_MS", 10 * 60_000),
              signal: execution.signal,
            }));
          if (!taskPrompt.trim()) {
            return { status: "skipped", reason: "prompt script produced no output" } as const;
          }
          if (!getTopic(job.topicId)?.agent) throw new Error("target topic was deleted during run");
          const prompt = [
            `<scheduled-task name="${job.name}" run-id="${run.id}">`,
            "This is a background scheduled run. Do not ask interactive questions.",
            "All scheduled tasks in this topic share one Cron conversation.",
            "Use relevant conclusions and state from previous scheduled runs before acting.",
            "Complete the task and report only meaningful results in the user's language.",
            taskPrompt,
            "</scheduled-task>",
          ].join("\n");
          const requestId = `cron:${run.id}`;
          const queryId = triggerTopicAiTurn(
            job.topicId,
            job.ownerUserId,
            prompt,
            execution.agent,
            {
              origin: `cron:${job.id}:${run.id}`,
              requestId,
              hideInjectMessage: true,
              modelOverride: job.model,
              effortOverride: job.effort,
              sessionId: execution.sessionId ?? null,
              sessionName: execution.sessionName,
              sessionType: "cron",
              onDispatched: hooks.onDispatched,
              onSessionId: hooks.onSessionId,
              onSessionReset: hooks.onSessionReset,
              bridgeSessionFromHistory: true,
              onSettled: hooks.onSettled,
            },
          );
          return {
            status: queryId ? ("dispatched" as const) : ("deferred" as const),
            requestId,
            ...(queryId ? { queryId } : {}),
            cancel: () => cancelDeferredInject(job.topicId, requestId),
          };
        },
      };
      const scheduler = new CronScheduler(schedulerOptions);
      scheduler.start();

      return {
        async stop() {
          scheduler.stop();
          unsubscribeTopicCleanup();
          unregisterBackgroundSessions();
          unregisterMcp();
          await Promise.allSettled(cleanupTasks);
        },
      };
    },
  };
}
