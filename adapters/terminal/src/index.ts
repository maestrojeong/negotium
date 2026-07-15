import { defineNegotiumAdapter, type NegotiumAdapterHandle } from "@negotium/adapter-sdk";
import { TerminalApp, type TerminalAppOptions } from "@/app";
import { type EmbeddedClientOptions, EmbeddedNegotiumClient, type NegotiumClient } from "@/client";

export type { TerminalAppOptions } from "@/app";
export { TerminalApp } from "@/app";
export type { EmbeddedClientOptions, NegotiumClient, RemoteClientOptions } from "@/client";
export { EmbeddedNegotiumClient, RemoteNegotiumClient } from "@/client";
export { renderApp } from "@/render";
export type { AppState } from "@/state";

export interface TerminalAdapterOptions extends TerminalAppOptions {
  /** Inject a remote or embedded client. Defaults to an in-process Negotium node. */
  client?: NegotiumClient;
  /** Embedded node port; zero selects an ephemeral port. Ignored with a custom client. */
  port?: EmbeddedClientOptions["port"];
  /** False attaches this TUI to a node already started in the same process. */
  startNode?: EmbeddedClientOptions["startNode"];
}

export interface TerminalAdapterHandle extends NegotiumAdapterHandle<"terminal"> {
  /** Settles after the user exits, stop() completes, or startup fails. */
  readonly completed: Promise<void>;
}

/** Start the TUI without hiding its lifecycle from an embedding host. */
export function startTerminalAdapter(options: TerminalAdapterOptions): TerminalAdapterHandle {
  const client =
    options.client ??
    new EmbeddedNegotiumClient({
      userId: options.userId,
      port: options.port,
      startNode: options.startNode,
    });
  const app = new TerminalApp(client, options);
  const completed = app.run();
  return {
    name: "terminal",
    completed,
    async stop(): Promise<void> {
      app.stop();
      await completed;
    },
  };
}

/** Declarative form used by hosts that load adapters from a registry. */
export const terminalAdapter = defineNegotiumAdapter({
  name: "terminal",
  capabilities: {
    localUserInput: true,
    topicManagement: true,
    externalPlacedTurn: false,
  },
  projection: {
    transcript: "full",
    historyBackfill: true,
    externalAuthors: "native",
  },
  start: startTerminalAdapter,
});
