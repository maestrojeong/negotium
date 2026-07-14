import { fileURLToPath } from "node:url";
import {
  buildStdioMcpServer,
  type NegotiumNodeModule,
  registerRuntimeMcpServer,
  triggerTopicAiTurn,
} from "@negotium/core";
import { CronScheduler, type CronSchedulerOptions } from "#scheduler";
import { ensureCronSchema } from "#store";

const MCP_SERVER_FILE = fileURLToPath(new URL("./mcp-server.ts", import.meta.url));

export interface CronModuleOptions {
  pollIntervalMs?: number;
  runTimeoutMs?: number;
}

function envMs(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createCronModule(options: CronModuleOptions = {}): NegotiumNodeModule {
  return {
    name: "cron",
    capabilities: ["scheduler.cron.v1"],
    start(context) {
      ensureCronSchema();
      const unregisterMcp = registerRuntimeMcpServer("cron-manager", {
        scopes: ["forum", "manager"],
        forumRequired: true,
        build({ userId, session, topicId, agent }) {
          const args = [`--user-id=${userId}`, `--topic=${session}`];
          if (topicId) args.push(`--topic-id=${topicId}`);
          return buildStdioMcpServer(agent, MCP_SERVER_FILE, args);
        },
      });

      const schedulerOptions: CronSchedulerOptions = {
        bus: context.bus,
        pollIntervalMs: options.pollIntervalMs ?? envMs("NEGOTIUM_CRON_POLL_INTERVAL_MS", 1_000),
        runTimeoutMs: options.runTimeoutMs ?? envMs("NEGOTIUM_CRON_RUN_TIMEOUT_MS", 10 * 60_000),
        dispatch(job, run, hooks) {
          const prompt = [
            `<scheduled-task name="${job.name}" run-id="${run.id}">`,
            "This is a background scheduled run. Do not ask interactive questions.",
            "Complete the task and report only meaningful results in the user's language.",
            job.prompt,
            "</scheduled-task>",
          ].join("\n");
          return triggerTopicAiTurn(job.topicId, job.ownerUserId, prompt, job.agent, {
            origin: `cron:${job.id}:${run.id}`,
            requestId: `cron:${run.id}`,
            hideInjectMessage: true,
            modelOverride: job.model,
            effortOverride: job.effort,
            sessionId: job.sessionId ?? null,
            sessionName: `cron-${job.id}`,
            sessionType: "cron",
            onDispatched: hooks.onDispatched,
            onSessionId: hooks.onSessionId,
            onSettled: hooks.onSettled,
          });
        },
      };
      const scheduler = new CronScheduler(schedulerOptions);
      scheduler.start();

      return {
        stop() {
          scheduler.stop();
          unregisterMcp();
        },
      };
    },
  };
}
