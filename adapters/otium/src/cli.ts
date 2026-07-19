#!/usr/bin/env bun
/**
 * negotium-otium — run a negotium node as an otium workspace worker.
 *
 *   negotium-otium join <invite-code>   store credentials from an invite code
 *   negotium-otium serve                canonical node + Otium sidecar
 *   negotium-otium bindings             inspect internal/shared Otium transports
 *   negotium-otium share ...            bind an Otium room to a visible local topic
 *   negotium-otium private ...          keep a topic on Terminal/Telegram only
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

async function resolveHostNodeId(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const [{ configureOtiumCentral, listPeerNodes }, { loadJoin }] = await Promise.all([
    import("@/central"),
    import("@/join"),
  ]);
  const join = loadJoin();
  if (!join) throw new Error("not joined to an Otium workspace; pass --host-node or join first");
  configureOtiumCentral(join);
  try {
    const nodes = await listPeerNodes({ fresh: true });
    const primary =
      nodes.find((node) => node.isPrimary && !node.self) ?? nodes.find((node) => node.isPrimary);
    if (!primary) throw new Error("workspace has no primary Otium node");
    return primary.cellId;
  } finally {
    configureOtiumCentral(null);
  }
}

async function spawnCanonicalNode(): Promise<void> {
  const entry = process.argv[1];
  if (!entry) throw new Error("cannot locate the Negotium CLI entrypoint");
  const { LOG_DIR } = await import("@negotium/core");
  const child = Bun.spawn({
    cmd: [process.execPath, entry, "__node-daemon", "--port=0"],
    detached: true,
    env: { ...process.env, LOG_LEVEL: process.env.NEGOTIUM_NODE_LOG_LEVEL?.trim() || "info" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: Bun.file(`${LOG_DIR}/node-daemon.log`),
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
  const { onShutdown } = await import("@negotium/core");
  const { MAX_PEER_INPUT_REQUEST_BYTES, mountConfiguredOtiumNodeRuntime } = await import(
    "@/node-runtime"
  );
  const { runNodeDaemon } = await import("@negotium/node");
  const runtime = mountConfiguredOtiumNodeRuntime();
  if (runtime) onShutdown("otium-node-runtime", 125, () => runtime.stop());
  await runNodeDaemon({ port: 0, maxRequestBodySize: MAX_PEER_INPUT_REQUEST_BYTES });
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
      const { configureOtiumCentral } = await import("@/central");
      const { loadJoin, removeJoin } = await import("@/join");
      const { disconnectSharedTopics } = await import("@/shared-topic-sync");
      const join = loadJoin();
      if (!join) throw new Error("not joined to an Otium workspace");
      configureOtiumCentral(join);
      try {
        await disconnectSharedTopics(join);
        removeJoin();
      } finally {
        configureOtiumCentral(null);
      }
      console.log("disconnected from Otium; local shared topics are now private");
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
    case "bindings": {
      const { listOtiumTopicBindings } = await import("@/bindings");
      const bindings = listOtiumTopicBindings();
      if (bindings.length === 0) {
        console.log("no Otium topic bindings");
        break;
      }
      for (const binding of bindings) {
        const local = binding.localTopicTitle
          ? `${binding.localTopicTitle} (${binding.localTopicId})`
          : `${binding.localTopicId} [missing]`;
        console.log(
          `${binding.transport.padEnd(16)} ${binding.hostNodeId}/${binding.hostTopicId} -> ${local}`,
        );
      }
      break;
    }
    case "share": {
      const parsed = parseArgs(commandArgs);
      const [hostTopicId, localTopicId] = parsed.positional;
      const userId = parsed.options.get("user")?.trim();
      if (!hostTopicId || !localTopicId || !userId) {
        throw new Error(
          "usage: negotium otium share <host-topic-id> <local-topic-id> --user <user-id> [--host-node <cell-id>]",
        );
      }
      const hostNodeId = await resolveHostNodeId(parsed.options.get("host-node"));
      const { shareOtiumTopic } = await import("@/bindings");
      const result = shareOtiumTopic({ hostNodeId, hostTopicId, localTopicId, userId });
      if (!result.ok) throw new Error(result.error);
      console.log(
        `shared ${hostNodeId}/${hostTopicId} with local topic ${result.localTopicId}` +
          (result.replaced ? " (replaced previous binding)" : ""),
      );
      break;
    }
    case "private": {
      const parsed = parseArgs(commandArgs);
      const [localTopicId] = parsed.positional;
      const userId = parsed.options.get("user")?.trim();
      if (!localTopicId || !userId) {
        throw new Error("usage: negotium otium private <local-topic-id> --user <user-id>");
      }
      const { setOtiumTopicPrivate } = await import("@/bindings");
      const result = setOtiumTopicPrivate({ localTopicId, userId });
      if (!result.ok) throw new Error(result.error);
      console.log(
        `private mode selected for ${result.localTopicId}; removed ${result.removedBindings} Otium binding(s)`,
      );
      break;
    }
    default: {
      console.log(
        [
          "negotium otium — attach a Negotium node to an Otium workspace",
          "",
          "usage: negotium otium <join|leave|serve|bindings|share|private> [args]",
          "",
          "  join <code>   store credentials from an Otium invite code",
          "  leave         delete Hub copies, make local topics private, and remove credentials",
          "  serve [--port <port>] [--relay <url>]",
          "                 run peer routes and an outbound relay tunnel",
          "  bindings      list internal mirrors and shared topic bindings",
          "  share <host-topic> <local-topic> --user <id> [--host-node <cell>]",
          "                 publish one private local topic to Otium as shared",
          "  private <local-topic> --user <id>",
          "                 remove all Otium bindings; keep Terminal/Telegram access",
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
