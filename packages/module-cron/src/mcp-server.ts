#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  EFFORT_VALUES,
  type EffortLevel,
  getRegistry,
  getTopic,
  getTopicByNameForUser,
  isAgentKind,
} from "@negotium/core";
import { z } from "zod";
import {
  CRON_CONTEXT_RETAIN_TURNS,
  CRON_CONTEXT_ROTATE_EVERY,
  resetCronTopicContext,
  updateCronJobWithContextReset,
} from "#context";
import { cronScriptExists, listCronScripts } from "#scripts";
import {
  countCronRuns,
  createCronJob,
  deleteCronJob,
  getCronJob,
  getCronJobByOwnerAndName,
  getCronTopicContext,
  listCronJobs,
  listCronRuns,
  listCronTopicSessions,
  requestCronCancel,
  requestCronRun,
  setCronJobEnabled,
} from "#store";
import { queueCronPromptSummary } from "#summarize";

const args = process.argv.slice(2);
const arg = (name: string) =>
  args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? "";
const userId = arg("user-id");
const currentTopic = arg("topic");
const currentTopicId = arg("topic-id");
const authorized = arg("authorized") === "true";
const efforts = new Set<string>(EFFORT_VALUES);

function ok(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function fail(error: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
    ],
  };
}

function resolveTopic(input?: { topic_id?: string; topic?: string }) {
  const topicId = input?.topic_id?.trim() || currentTopicId;
  if (topicId) return getTopic(topicId);
  const title = input?.topic?.trim() || currentTopic;
  return title ? getTopicByNameForUser(title, userId) : null;
}

function ownsTopic(topic: NonNullable<ReturnType<typeof getTopic>>): boolean {
  return authorized || topic.participants.some((participant) => participant.userId === userId);
}

function canSeeJob(job: NonNullable<ReturnType<typeof getCronJob>>): boolean {
  if (authorized) return true;
  if (job.ownerUserId === userId) return true;
  const topic = getTopic(job.topicId);
  return Boolean(topic && ownsTopic(topic));
}

function resolveVisibleJob(input: { job_id?: string; name?: string }) {
  const job = input.job_id?.trim()
    ? getCronJob(input.job_id.trim())
    : (() => {
        const name = input.name?.trim();
        if (!name) return null;
        const matches = listCronJobs().filter((entry) => entry.name === name && canSeeJob(entry));
        if (matches.length > 1)
          throw new Error(`multiple visible jobs named '${name}'; use job_id`);
        return matches[0] ?? null;
      })();
  if (!job) throw new Error("cron job not found; provide job_id or name");
  if (!canSeeJob(job)) throw new Error("cron job not found");
  return job;
}

function resolveOwnedJob(input: { job_id?: string; name?: string }) {
  const job = resolveVisibleJob(input);
  if (!authorized && job.ownerUserId !== userId)
    throw new Error("only the job owner can mutate this cron job");
  return job;
}

function jobDto(job: NonNullable<ReturnType<typeof getCronJob>>) {
  const runs = listCronRuns(job.id, 1);
  const contextState = getCronTopicContext(job.topicId);
  const canMutate = authorized || job.ownerUserId === userId;
  const prompt = job.prompt?.trim() ?? "";
  return {
    ...job,
    canMutate,
    prompt: canMutate ? prompt || null : null,
    promptPreview: prompt ? prompt.replace(/\s+/g, " ").slice(0, 180) : null,
    summary: job.summary ?? null,
    runCount: countCronRuns(job.id),
    context: {
      scope: "topic",
      sessionName: `cron-${job.topicId}`,
      providers: listCronTopicSessions(job.topicId).map((session) => session.agent),
      successfulRunsSinceRotation: contextState?.successfulRunsSinceRotation ?? 0,
      rotateEvery: CRON_CONTEXT_ROTATE_EVERY,
      retainTurns: CRON_CONTEXT_RETAIN_TURNS,
      lastRotatedAt: contextState?.lastRotatedAt ?? null,
    },
    lastRun: runs[0] ?? null,
  };
}

const jobRef = {
  job_id: z.string().optional().describe("Cron job id"),
  name: z.string().optional().describe("Cron job name visible to the current user"),
};

const server = new McpServer({ name: "negotium-cron", version: "0.1.0" });

server.tool(
  "cron_create",
  "Create a persistent prompt- or Python-script-based scheduled task for a topic. All jobs in the topic share one Cron conversation.",
  {
    name: z.string().describe("Unique name using letters, numbers, dash, or underscore"),
    prompt: z.string().optional().describe("Inline task instructions, up to 20,000 characters"),
    script: z
      .string()
      .optional()
      .describe("Plain .py filename from the node Cron jobs directory; stdout becomes the prompt"),
    schedule: z.string().describe("Five-field cron expression, e.g. '0 9 * * 1-5'"),
    timezone: z.string().optional().describe("IANA timezone, e.g. America/Los_Angeles"),
    topic_id: z.string().optional(),
    topic: z.string().optional(),
    agent: z.string().optional().describe("claude, codex, or maestro"),
    model: z.string().optional(),
    effort: z.string().optional().describe("low, medium, high, xhigh, or max"),
  },
  async ({ name, prompt, script, schedule, timezone, topic_id, topic, agent, model, effort }) => {
    try {
      if (!userId) throw new Error("missing user context");
      const cleanName = name.trim();
      if (!/^[A-Za-z0-9_-]+$/.test(cleanName)) {
        throw new Error("name must use only letters, numbers, dashes, and underscores");
      }
      const cleanPrompt = prompt?.trim() || undefined;
      const cleanScript = script?.trim() || undefined;
      if (Boolean(cleanPrompt) === Boolean(cleanScript)) {
        throw new Error("provide exactly one of prompt or script");
      }
      if (cleanPrompt && cleanPrompt.length > 20_000) {
        throw new Error("prompt must be 20,000 characters or fewer");
      }
      if (cleanScript && !cronScriptExists(cleanScript)) {
        throw new Error(`cron script not found: ${cleanScript}`);
      }
      if (getCronJobByOwnerAndName(userId, cleanName))
        throw new Error(`cron job already exists: ${cleanName}`);
      const target = resolveTopic({ topic_id, topic });
      if (!target || !ownsTopic(target)) throw new Error("target topic not found");
      if (!target.agent) throw new Error("target topic has no agent");
      const resolvedAgent = agent?.trim();
      if (resolvedAgent && !isAgentKind(resolvedAgent))
        throw new Error(`invalid agent: ${resolvedAgent}`);
      const effectiveAgent = isAgentKind(resolvedAgent) ? resolvedAgent : target.agent;
      const registry = getRegistry(effectiveAgent);
      const cleanModel = model?.trim() || undefined;
      if (cleanModel && !registry.validateModel(cleanModel)) {
        throw new Error(`model '${cleanModel}' is invalid for ${effectiveAgent}`);
      }
      const cleanEffort = effort?.trim();
      if (cleanEffort && !efforts.has(cleanEffort))
        throw new Error(`invalid effort: ${cleanEffort}`);
      const resolvedEffort = cleanEffort as EffortLevel | undefined;
      if (resolvedEffort && !registry.validateEffort(resolvedEffort)) {
        throw new Error(`effort '${resolvedEffort}' is invalid for ${effectiveAgent}`);
      }
      return ok(
        (() => {
          const job = createCronJob({
            name: cleanName,
            ownerUserId: userId,
            topicId: target.id,
            prompt: cleanPrompt,
            script: cleanScript,
            schedule: schedule.trim(),
            timezone,
            agent: isAgentKind(resolvedAgent) ? resolvedAgent : undefined,
            model: cleanModel,
            effort: resolvedEffort,
          });
          if (cleanPrompt) queueCronPromptSummary(job.id, cleanPrompt);
          return jobDto(job);
        })(),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  "cron_list_scripts",
  "List available Python prompt scripts on this node.",
  {},
  async () => ok({ scripts: listCronScripts() }),
);

server.tool(
  "cron_edit",
  "Update a scheduled task. Source, topic, or runtime changes reset its shared Cron context.",
  {
    ...jobRef,
    new_name: z.string().optional(),
    prompt: z.string().nullable().optional(),
    script: z.string().nullable().optional(),
    schedule: z.string().optional(),
    timezone: z.string().nullable().optional(),
    topic_id: z.string().optional(),
    topic: z.string().optional(),
    agent: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  },
  async ({
    job_id,
    name,
    new_name,
    prompt,
    script,
    schedule,
    timezone,
    topic_id,
    topic,
    agent,
    model,
    effort,
    enabled,
  }) => {
    try {
      const job = resolveOwnedJob({ job_id, name });
      const target = topic_id || topic ? resolveTopic({ topic_id, topic }) : getTopic(job.topicId);
      if (!target || !ownsTopic(target) || !target.agent) throw new Error("target topic not found");

      const cleanName = new_name?.trim();
      if (cleanName && !/^[A-Za-z0-9_-]+$/.test(cleanName)) {
        throw new Error("name must use only letters, numbers, dashes, and underscores");
      }
      if (cleanName) {
        const duplicate = getCronJobByOwnerAndName(userId, cleanName);
        if (duplicate && duplicate.id !== job.id)
          throw new Error(`cron job already exists: ${cleanName}`);
      }

      let nextPrompt = prompt !== undefined ? prompt?.trim() || undefined : job.prompt;
      let nextScript = script !== undefined ? script?.trim() || undefined : job.script;
      if (prompt !== undefined && nextPrompt) nextScript = undefined;
      if (script !== undefined && nextScript) nextPrompt = undefined;
      if (Boolean(nextPrompt) === Boolean(nextScript)) {
        throw new Error("provide exactly one of prompt or script");
      }
      if (nextPrompt && nextPrompt.length > 20_000) {
        throw new Error("prompt must be 20,000 characters or fewer");
      }
      if (nextScript && !cronScriptExists(nextScript)) {
        throw new Error(`cron script not found: ${nextScript}`);
      }

      const rawAgent = agent?.trim() || undefined;
      if (rawAgent && !isAgentKind(rawAgent)) throw new Error(`invalid agent: ${rawAgent}`);
      const nextAgent =
        agent !== undefined ? (isAgentKind(rawAgent) ? rawAgent : undefined) : job.agent;
      const effectiveAgent = nextAgent ?? target.agent;
      const registry = getRegistry(effectiveAgent);
      const nextModel = model !== undefined ? model?.trim() || undefined : job.model;
      if (nextModel && !registry.validateModel(nextModel)) {
        throw new Error(`model '${nextModel}' is invalid for ${effectiveAgent}`);
      }
      const rawEffort = effort?.trim() || undefined;
      if (rawEffort && !efforts.has(rawEffort)) throw new Error(`invalid effort: ${rawEffort}`);
      const nextEffort = effort !== undefined ? (rawEffort as EffortLevel | undefined) : job.effort;
      if (nextEffort && !registry.validateEffort(nextEffort)) {
        throw new Error(`effort '${nextEffort}' is invalid for ${effectiveAgent}`);
      }

      const sourceChanged = nextPrompt !== job.prompt || nextScript !== job.script;
      const updated = await updateCronJobWithContextReset(job.id, {
        name: cleanName,
        topicId: target.id !== job.topicId ? target.id : undefined,
        prompt: prompt !== undefined || script !== undefined ? (nextPrompt ?? null) : undefined,
        script: prompt !== undefined || script !== undefined ? (nextScript ?? null) : undefined,
        summary: sourceChanged ? null : undefined,
        schedule: schedule?.trim(),
        timezone,
        agent: agent !== undefined ? (nextAgent ?? null) : undefined,
        model: model !== undefined ? (nextModel ?? null) : undefined,
        effort: effort !== undefined ? (nextEffort ?? null) : undefined,
        enabled,
      });
      if (!updated) throw new Error("cron job not found");
      if (sourceChanged && nextPrompt) queueCronPromptSummary(updated.id, nextPrompt);
      return ok(jobDto(updated));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  "cron_list",
  "List scheduled tasks visible through ownership or topic participation.",
  {
    topic_id: z.string().optional(),
    topic: z.string().optional(),
    include_disabled: z.boolean().optional(),
  },
  async ({ topic_id, topic, include_disabled }) => {
    if (!userId) return fail("missing user context");
    const target = topic_id || topic ? resolveTopic({ topic_id, topic }) : null;
    if ((topic_id || topic) && !target) return fail("target topic not found");
    return ok(
      listCronJobs()
        .filter(canSeeJob)
        .filter((job) => (target ? job.topicId === target.id : true))
        .filter((job) => (include_disabled === false ? job.enabled : true))
        .map(jobDto),
    );
  },
);

server.tool(
  "cron_inspect",
  "Inspect one scheduled task and its recent run history.",
  jobRef,
  async (input) => {
    try {
      const job = resolveVisibleJob(input);
      return ok({ ...jobDto(job), runs: listCronRuns(job.id, 20) });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  "cron_logs",
  "Show durable run history for one scheduled task. This replaces per-process pm2 logs.",
  { ...jobRef, limit: z.number().int().min(1).max(100).optional() },
  async ({ limit, ...input }) => {
    try {
      const job = resolveOwnedJob(input);
      return ok({ jobId: job.id, runs: listCronRuns(job.id, limit ?? 20) });
    } catch (error) {
      return fail(error);
    }
  },
);

for (const [toolName, enabled] of [
  ["cron_pause", false],
  ["cron_resume", true],
] as const) {
  server.tool(
    toolName,
    `${enabled ? "Resume" : "Pause"} a scheduled task.`,
    jobRef,
    async (input) => {
      try {
        const job = resolveOwnedJob(input);
        return ok(jobDto(setCronJobEnabled(job.id, enabled)!));
      } catch (error) {
        return fail(error);
      }
    },
  );
}

server.tool(
  "cron_restart",
  "Re-arm a scheduled task from the current time. The central scheduler has no per-job process to restart.",
  jobRef,
  async (input) => {
    try {
      const job = resolveOwnedJob(input);
      return ok(jobDto(setCronJobEnabled(job.id, true)!));
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  "cron_run",
  "Queue one immediate run without changing the schedule.",
  jobRef,
  async (input) => {
    try {
      const job = resolveOwnedJob(input);
      if (!job.enabled) throw new Error("job is disabled; use cron_resume first");
      return ok({ queued: true, requestId: requestCronRun(job.id), jobId: job.id });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  "cron_reset",
  "Reset the shared Cron conversation for the task's entire topic.",
  jobRef,
  async (input) => {
    try {
      const job = resolveOwnedJob(input);
      const sessions = await resetCronTopicContext(job.topicId);
      return ok({ reset: true, topicId: job.topicId, clearedProviderSessions: sessions });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  "cron_kill",
  "Cancel an active or queued run, including its agent or Python process tree.",
  jobRef,
  async (input) => {
    try {
      const job = resolveOwnedJob(input);
      return ok({
        cancellationQueued: true,
        requestId: requestCronCancel(job.id),
        jobId: job.id,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool(
  "cron_delete",
  "Delete a scheduled task and its run history.",
  jobRef,
  async (input) => {
    try {
      const job = resolveOwnedJob(input);
      deleteCronJob(job.id);
      return ok({ deleted: true, jobId: job.id });
    } catch (error) {
      return fail(error);
    }
  },
);

server.tool("cron_status", "Show a compact scheduled-task status summary.", {}, async () => {
  if (!userId) return fail("missing user context");
  const jobs = listCronJobs().filter(canSeeJob);
  return ok({
    backend: "sqlite-central-scheduler",
    total: jobs.length,
    enabled: jobs.filter((job) => job.enabled).length,
    disabled: jobs.filter((job) => !job.enabled).length,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      topicId: job.topicId,
      enabled: job.enabled,
      nextRunAt: job.nextRunAt,
      lastRun: listCronRuns(job.id, 1)[0] ?? null,
      contextProviders: listCronTopicSessions(job.topicId).map((session) => session.agent),
      contextRunsSinceRotation: getCronTopicContext(job.topicId)?.successfulRunsSinceRotation ?? 0,
    })),
  });
});

server.tool(
  "cron_reconcile",
  "Validate the current user's DB-backed schedules. No pm2 process reconciliation is required.",
  {},
  async () => {
    if (!userId) return fail("missing user context");
    const jobs = listCronJobs(userId);
    const invalid = jobs
      .filter((job) => {
        const topic = getTopic(job.topicId);
        return !topic?.agent || !ownsTopic(topic);
      })
      .map((job) => job.id);
    return ok({
      backend: "sqlite-central-scheduler",
      checked: jobs.length,
      invalid,
      externalProcesses: 0,
      drift: 0,
    });
  },
);

await server.connect(new StdioServerTransport());
