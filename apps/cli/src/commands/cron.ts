/** `negotium cron ...` — persistent scheduled agent turns. */

import {
  EFFORT_VALUES,
  type EffortLevel,
  getRegistry,
  getTopic,
  getTopicByNameForUser,
  isAgentKind,
} from "@negotium/core";
import {
  CRON_JOBS_DIR,
  createCronJob,
  cronScriptExists,
  deleteCronJob,
  getCronJob,
  getCronJobByOwnerAndName,
  listCronJobs,
  listCronRuns,
  queueCronPromptSummary,
  requestCronCancel,
  requestCronRun,
  resetCronTopicContext,
  setCronJobEnabled,
  updateCronJobWithContextReset,
} from "@negotium/module-cron";

const USER_ID = "local";

function flag(args: string[], name: string): string | undefined {
  return args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function hasFlag(args: string[], name: string): boolean {
  return args.some((value) => value.startsWith(`--${name}=`));
}

function positional(args: string[]): string[] {
  return args.filter((value) => !value.startsWith("--"));
}

function resolveJob(ref: string) {
  return getCronJob(ref) ?? getCronJobByOwnerAndName(USER_ID, ref);
}

function printJob(job: NonNullable<ReturnType<typeof getCronJob>>): void {
  const last = listCronRuns(job.id, 1)[0];
  console.log(
    `${job.name}  ${job.enabled ? "enabled" : "paused"}  ${job.schedule}` +
      `${job.timezone ? ` (${job.timezone})` : ""}  next=${job.nextRunAt}` +
      `${last ? `  last=${last.status}` : ""}  ${job.id}`,
  );
}

function usage(): void {
  console.log(
    [
      "negotium cron commands:",
      "  list",
      "  create <topic> <name> '<schedule>' <prompt...> [--timezone=IANA] [--agent=...] [--model=...] [--effort=...]",
      "  create <topic> <name> '<schedule>' --script=job.py [--timezone=IANA] [--agent=...]",
      "  edit <name|id> [prompt...] [--name=...] [--topic=...] [--schedule=...] [--script=job.py]",
      "  inspect|logs <name|id>",
      "  run|pause|resume|restart|kill|reset|delete <name|id>",
      "",
      "The node must stay alive (`negotium serve` or an adapter) for schedules to run.",
      `Python prompt scripts live in ${CRON_JOBS_DIR}.`,
    ].join("\n"),
  );
}

export async function cronCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case undefined:
      case "help":
      case "--help":
        usage();
        return;
      case "list": {
        const jobs = listCronJobs(USER_ID);
        if (jobs.length === 0) {
          console.log("no cron jobs");
          return;
        }
        jobs.forEach(printJob);
        return;
      }
      case "create": {
        const values = positional(rest);
        const [topicName, name, schedule, ...promptParts] = values;
        const script = flag(rest, "script")?.trim() || undefined;
        if (!topicName || !name || !schedule || (promptParts.length === 0 && !script)) {
          usage();
          process.exitCode = 1;
          return;
        }
        if (script && promptParts.length > 0) {
          throw new Error("provide a prompt or --script, not both");
        }
        if (script && !cronScriptExists(script))
          throw new Error(`cron script not found: ${script}`);
        const topic = getTopicByNameForUser(topicName, USER_ID);
        if (!topic?.agent) throw new Error(`topic not found or has no agent: ${topicName}`);
        const agentRaw = flag(rest, "agent");
        if (agentRaw && !isAgentKind(agentRaw)) throw new Error(`invalid agent: ${agentRaw}`);
        const agent = isAgentKind(agentRaw) ? agentRaw : undefined;
        const effectiveAgent = agent ?? topic.agent;
        const registry = getRegistry(effectiveAgent);
        const model = flag(rest, "model");
        if (model && !registry.validateModel(model)) {
          throw new Error(`model '${model}' is invalid for ${effectiveAgent}`);
        }
        const effortRaw = flag(rest, "effort");
        if (effortRaw && !(EFFORT_VALUES as readonly string[]).includes(effortRaw)) {
          throw new Error(`invalid effort: ${effortRaw}`);
        }
        const effort = effortRaw as EffortLevel | undefined;
        if (effort && !registry.validateEffort(effort)) {
          throw new Error(`effort '${effort}' is invalid for ${effectiveAgent}`);
        }
        const job = createCronJob({
          name,
          ownerUserId: USER_ID,
          topicId: topic.id,
          prompt: promptParts.length > 0 ? promptParts.join(" ") : undefined,
          script,
          schedule,
          timezone: flag(rest, "timezone"),
          agent,
          model,
          effort,
        });
        if (job.prompt) queueCronPromptSummary(job.id, job.prompt);
        printJob(job);
        return;
      }
      case "edit": {
        const values = positional(rest);
        const [ref, ...promptParts] = values;
        if (!ref) throw new Error("provide a cron name or id");
        const job = resolveJob(ref);
        if (!job || job.ownerUserId !== USER_ID) throw new Error(`cron job not found: ${ref}`);
        const topicName = flag(rest, "topic");
        const topic = topicName ? getTopicByNameForUser(topicName, USER_ID) : null;
        if (topicName && !topic?.agent)
          throw new Error(`topic not found or has no agent: ${topicName}`);
        const scriptTouched = hasFlag(rest, "script");
        const script = flag(rest, "script")?.trim() || undefined;
        if (script && !cronScriptExists(script))
          throw new Error(`cron script not found: ${script}`);
        if (script && promptParts.length > 0)
          throw new Error("provide a prompt or --script, not both");
        const sourceTouched = scriptTouched || promptParts.length > 0;
        const nextPrompt =
          promptParts.length > 0 ? promptParts.join(" ") : sourceTouched ? undefined : job.prompt;
        const nextScript = scriptTouched ? script : promptParts.length > 0 ? undefined : job.script;
        if (sourceTouched && Boolean(nextPrompt) === Boolean(nextScript)) {
          throw new Error("cron job requires exactly one of prompt or script");
        }

        const agentRaw = flag(rest, "agent");
        const agent = agentRaw === "default" ? undefined : agentRaw;
        if (agent && !isAgentKind(agent)) throw new Error(`invalid agent: ${agent}`);
        const effectiveAgent =
          (isAgentKind(agent) ? agent : hasFlag(rest, "agent") ? undefined : job.agent) ??
          topic?.agent ??
          getTopic(job.topicId)?.agent;
        const modelRaw = flag(rest, "model");
        const model = modelRaw === "default" ? undefined : modelRaw?.trim() || undefined;
        const effortRaw = flag(rest, "effort");
        const effort = effortRaw === "default" ? undefined : effortRaw;
        if (effort && !(EFFORT_VALUES as readonly string[]).includes(effort)) {
          throw new Error(`invalid effort: ${effort}`);
        }
        if (effectiveAgent) {
          const registry = getRegistry(effectiveAgent);
          if (model && !registry.validateModel(model)) {
            throw new Error(`model '${model}' is invalid for ${effectiveAgent}`);
          }
          if (effort && !registry.validateEffort(effort as EffortLevel)) {
            throw new Error(`effort '${effort}' is invalid for ${effectiveAgent}`);
          }
        }

        const updated = await updateCronJobWithContextReset(job.id, {
          name: flag(rest, "name"),
          topicId: topic?.id,
          prompt: sourceTouched ? (nextPrompt ?? null) : undefined,
          script: sourceTouched ? (nextScript ?? null) : undefined,
          summary: sourceTouched ? null : undefined,
          schedule: flag(rest, "schedule"),
          timezone: hasFlag(rest, "timezone") ? flag(rest, "timezone") || null : undefined,
          agent: hasFlag(rest, "agent") ? (isAgentKind(agent) ? agent : null) : undefined,
          model: hasFlag(rest, "model") ? (model ?? null) : undefined,
          effort: hasFlag(rest, "effort")
            ? ((effort as EffortLevel | undefined) ?? null)
            : undefined,
        });
        if (!updated) throw new Error(`cron job not found: ${ref}`);
        if (sourceTouched && updated.prompt) queueCronPromptSummary(updated.id, updated.prompt);
        printJob(updated);
        return;
      }
      case "inspect":
      case "logs": {
        const ref = positional(rest)[0];
        if (!ref) throw new Error("provide a cron name or id");
        const job = resolveJob(ref);
        if (!job || job.ownerUserId !== USER_ID) throw new Error(`cron job not found: ${ref}`);
        console.log(JSON.stringify({ ...job, runs: listCronRuns(job.id, 20) }, null, 2));
        return;
      }
      case "run":
      case "pause":
      case "resume":
      case "restart":
      case "kill":
      case "reset":
      case "delete": {
        const ref = positional(rest)[0];
        if (!ref) throw new Error("provide a cron name or id");
        const job = resolveJob(ref);
        if (!job || job.ownerUserId !== USER_ID) throw new Error(`cron job not found: ${ref}`);
        if (sub === "run") {
          if (!job.enabled) throw new Error("job is disabled; resume it first");
          console.log(`queued ${requestCronRun(job.id)}`);
        }
        if (sub === "pause") printJob(setCronJobEnabled(job.id, false)!);
        if (sub === "resume") printJob(setCronJobEnabled(job.id, true)!);
        if (sub === "restart") printJob(setCronJobEnabled(job.id, true)!);
        if (sub === "kill") console.log(`cancellation queued ${requestCronCancel(job.id)}`);
        if (sub === "reset") {
          await resetCronTopicContext(job.topicId);
          console.log(`reset shared Cron context for topic ${job.topicId}`);
        }
        if (sub === "delete") {
          deleteCronJob(job.id);
          console.log(`deleted ${job.name}`);
        }
        return;
      }
      default:
        usage();
        process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
