#!/usr/bin/env bun
/**
 * negotium-otium — run a negotium node as an otium workspace worker.
 *
 *   negotium-otium join <invite-code>   store credentials from an invite code
 *   negotium-otium serve                negotium node + otium peer routes
 *   negotium-otium bindings             inspect internal/shared Otium transports
 *   negotium-otium share ...            bind an Otium room to a visible local topic
 *   negotium-otium private ...          keep a topic on Terminal/Telegram only
 *
 * The otium integration mounts onto the node through negotium's plugin chain
 * (registerNodeRequestHandler) — negotium core knows nothing about otium.
 */

import { MAX_PEER_INPUT_REQUEST_BYTES } from "@/protocol";

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

export async function runOtiumCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...commandArgs] = args;
  switch (command) {
    case "join": {
      const { joinCommand } = await import("@/join-cli");
      await joinCommand(commandArgs);
      break;
    }
    case "serve": {
      const {
        getRuntimeProcessLease,
        NEGOTIUM_PORT,
        onShutdown,
        registerNodeRequestHandler,
        unregisterNodeRequestHandler,
        waitForRuntimeProcessLease,
      } = await import("@negotium/core");
      const [{ startDefaultNode }, otium] = await Promise.all([
        import("@negotium/node"),
        import("@/index"),
      ]);
      const port = parseOtiumServePort(commandArgs, NEGOTIUM_PORT);
      const relayUrl = parseOtiumServeRelayUrl(commandArgs);
      let leaseLost = false;
      let stopForLeaseLoss: (() => void) | undefined;
      const singleton = await waitForRuntimeProcessLease("adapter:otium", {
        onLost: () => {
          leaseLost = true;
          console.error("negotium otium: singleton lease lost; shutting down");
          stopForLeaseLoss?.();
        },
      });
      if (!singleton) {
        const current = getRuntimeProcessLease("adapter:otium");
        throw new Error(
          `Otium adapter is already running${current ? ` (pid ${current.pid})` : ""}`,
        );
      }
      const { handleOtiumPeerRequest, startOtiumWorker } = otium;
      const worker = startOtiumWorker();
      if (!worker) {
        singleton.stop();
        throw new Error(
          "not joined to an otium workspace — run `negotium otium join <code>` first",
        );
      }
      registerNodeRequestHandler("otium-peer", handleOtiumPeerRequest);
      let workerStopped = false;
      const stopWorker = (): void => {
        if (workerStopped) return;
        workerStopped = true;
        unregisterNodeRequestHandler("otium-peer");
        worker.stop();
      };
      onShutdown("otium-worker", 100, stopWorker);
      onShutdown("otium-singleton", 90, () => singleton.stop());
      let node: Awaited<ReturnType<typeof startDefaultNode>>;
      try {
        node = await startDefaultNode({
          port,
          maxRequestBodySize: MAX_PEER_INPUT_REQUEST_BYTES,
        });
      } catch (error) {
        stopWorker();
        singleton.stop();
        throw error;
      }
      console.log(
        `negotium node (otium worker) listening on 127.0.0.1:${node.port} (ctrl-c to stop)`,
      );
      worker.startTunnel({ targetOrigin: `http://127.0.0.1:${node.port}`, relayUrl });
      await new Promise<void>((resolve) => {
        const stop = () => void node.stop().finally(resolve);
        stopForLeaseLoss = stop;
        if (leaseLost) stop();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
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
          "usage: negotium otium <join|serve|bindings|share|private> [args]",
          "",
          "  join <code>   store credentials from an Otium invite code",
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
