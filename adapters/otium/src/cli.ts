#!/usr/bin/env bun
/**
 * negotium-otium — run a negotium node as an otium workspace worker.
 *
 *   negotium-otium join <invite-code>   store credentials from an invite code
 *   negotium-otium leave                remove credentials
 *   negotium-otium serve                canonical node + Otium sidecar
 *
 * Per-topic sharing is expressed on the topic itself (`/public` / `/private`,
 * i.e. the `otium` surface) and discovered by the hub through the Runtime Gateway, so
 * this command no longer carries `bindings` / `share` / `private` subcommands.
 *
 * The runtime half mounts in the canonical node. This command only keeps the
 * public peer proxy and relay tunnel in the adapter sidecar process.
 */

function parseArgs(args: string[]): { positional: string[]; options: Map<string, string> } {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const equalsAt = value.indexOf("=");
    if (equalsAt > 2) {
      options.set(value.slice(2, equalsAt), value.slice(equalsAt + 1));
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      options.set(value.slice(2), next);
      i += 1;
    } else {
      options.set(value.slice(2), "true");
    }
  }
  return { positional, options };
}

export function parseOtiumServePort(args: string[], fallback: number): number {
  const parsed = parseArgs(args);
  if (
    parsed.positional.length > 0 ||
    [...parsed.options.keys()].some((key) => key !== "port" && key !== "relay")
  ) {
    throw new Error("usage: negotium otium serve [--port <1-65535>] [--relay <url>]");
  }
  const raw = parsed.options.get("port");
  const port = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("serve port must be an integer between 1 and 65535");
  }
  return port;
}

export function parseOtiumServeRelayUrl(args: string[]): string | undefined {
  const parsed = parseArgs(args);
  if (
    parsed.positional.length > 0 ||
    [...parsed.options.keys()].some((key) => key !== "port" && key !== "relay")
  ) {
    throw new Error("usage: negotium otium serve [--port <1-65535>] [--relay <url>]");
  }
  const raw = parsed.options.get("relay")?.trim();
  if (!raw) return undefined;
  if (!/^(?:https?|wss?):\/\//.test(raw)) {
    throw new Error("relay URL must use http(s) or ws(s)");
  }
  return raw.replace(/\/+$/, "");
}

async function spawnCanonicalNode(): Promise<void> {
  const entry = process.argv[1];
  if (!entry) throw new Error("cannot locate the Negotium CLI entrypoint");
  const { LOG_DIR, rotateOversizedLog } = await import("@negotium/core");
  const daemonLogPath = `${LOG_DIR}/node-daemon.log`;
  rotateOversizedLog(daemonLogPath);
  const child = Bun.spawn({
    cmd: [process.execPath, entry, "__node-daemon", "--port=0"],
    detached: true,
    env: { ...process.env, LOG_LEVEL: process.env.NEGOTIUM_NODE_LOG_LEVEL?.trim() || "info" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file(daemonLogPath),
  });
  child.unref();
}

async function ensureCanonicalNode(): Promise<void> {
  const { inspectNodeDaemon, waitForNodeDaemon } = await import("@negotium/node");
  const status = await inspectNodeDaemon();
  if (status.running) return;
  await spawnCanonicalNode();
  await waitForNodeDaemon(15_000);
}

async function runCanonicalNodeChild(): Promise<void> {
  const { hasConfiguredOtiumJoin } = await import("@/join-status");
  const { runNodeDaemon } = await import("@negotium/node");
  let maxRequestBodySize: number | undefined;
  if (hasConfiguredOtiumJoin()) {
    const { onShutdown } = await import("@negotium/core/node-host");
    const { MAX_PEER_REQUEST_BODY_BYTES, mountConfiguredOtiumNodeRuntime } = await import(
      "@/node-runtime"
    );
    const runtime = mountConfiguredOtiumNodeRuntime();
    if (runtime) onShutdown("otium-node-runtime", 125, () => runtime.stop());
    maxRequestBodySize = MAX_PEER_REQUEST_BODY_BYTES;
  }
  await runNodeDaemon({ port: 0, ...(maxRequestBodySize ? { maxRequestBodySize } : {}) });
}

export async function runOtiumCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...commandArgs] = args;
  switch (command) {
    case "__node-daemon": {
      await runCanonicalNodeChild();
      break;
    }
    case "join": {
      const { joinCommand } = await import("@/join-cli");
      await joinCommand(commandArgs);
      break;
    }
    case "leave": {
      if (commandArgs.length > 0) throw new Error(`usage: negotium otium ${command}`);
      if (
        process.env.OTIUM_CENTRAL_URL ||
        process.env.OTIUM_CELL_ID ||
        process.env.OTIUM_CELL_SECRET
      ) {
        throw new Error(
          "Otium join is configured by environment; remove OTIUM_CENTRAL_URL, OTIUM_CELL_ID, and OTIUM_CELL_SECRET to disconnect",
        );
      }
      const { loadJoin, removeJoin } = await import("@/join");
      if (!loadJoin()) throw new Error("not joined to an Otium workspace");
      // Removing the join file already cuts the hub off: the hub discovers
      // rooms only by calling this node through the Runtime Gateway, which
      // needs these credentials.
      //
      // Nothing is downgraded any more. A room is reachable from Otium because
      // it lives on the `otium` surface, and a surface is a permanent property
      // of the room — not consent to one specific workspace that has to be
      // revoked on disconnect (S-1, S-4).
      removeJoin();
      console.log("disconnected from Otium; workspace credentials removed");
      break;
    }
    case "serve": {
      const { NEGOTIUM_PORT } = await import("@negotium/core");
      const { runOtiumSidecar } = await import("@/sidecar");
      const port = parseOtiumServePort(commandArgs, NEGOTIUM_PORT);
      const relayUrl = parseOtiumServeRelayUrl(commandArgs);
      await ensureCanonicalNode();
      await runOtiumSidecar({ port, relayUrl });
      break;
    }
    default: {
      console.log(
        [
          "negotium otium — attach a Negotium node to an Otium workspace",
          "",
          "usage: negotium otium <join|leave|serve> [args]",
          "",
          "  join <code>   store credentials from an Otium invite code",
          "  leave         remove the stored workspace credentials",
          "  serve [--port <port>] [--relay <url>]",
          "                 run peer routes and an outbound relay tunnel",
          "",
          "Publish a topic to the workspace with /public in that topic; the hub",
          "discovers it over the Runtime Gateway. /private withdraws it.",
        ].join("\n"),
      );
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
    }
  }
}

if (import.meta.main) {
  runOtiumCli().catch((error) => {
    process.stderr.write(
      `negotium-otium: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
