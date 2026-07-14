/** `negotium cron ...` — persistent scheduled agent turns. */

import {
  EFFORT_VALUES,
  type EffortLevel,
  getRegistry,
  getTopicByNameForUser,
  isAgentKind,
} from "@negotium/core";
import {
  createCronJob,
  deleteCronJob,
  getCronJob,
  getCronJobByOwnerAndName,
  listCronJobs,
  listCronRuns,
  requestCronRun,
  setCronJobEnabled,
  setCronJobSessionId,
} from "@negotium/module-cron";

const USER_ID = "local";

function flag(args: string[], name: string): string | undefined {
  return args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
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
      "  inspect <name|id>",
      "  run|pause|resume|reset|delete <name|id>",
      "",
      "The node must stay alive (`negotium serve`, chat, or an adapter) for schedules to run.",
    ].join("\n"),
  );
}

export function cronCommand(args: string[]): void {
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
        if (!topicName || !name || !schedule || promptParts.length === 0) {
          usage();
          process.exitCode = 1;
          return;
        }
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
          prompt: promptParts.join(" "),
          schedule,
          timezone: flag(rest, "timezone"),
          agent,
          model,
          effort,
        });
        printJob(job);
        return;
      }
      case "inspect": {
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
      case "reset":
      case "delete": {
        const ref = positional(rest)[0];
        if (!ref) throw new Error("provide a cron name or id");
        const job = resolveJob(ref);
        if (!job || job.ownerUserId !== USER_ID) throw new Error(`cron job not found: ${ref}`);
        if (sub === "run") console.log(`queued ${requestCronRun(job.id)}`);
        if (sub === "pause") printJob(setCronJobEnabled(job.id, false)!);
        if (sub === "resume") printJob(setCronJobEnabled(job.id, true)!);
        if (sub === "reset") {
          setCronJobSessionId(job.id, null);
          console.log(`reset ${job.name}`);
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
