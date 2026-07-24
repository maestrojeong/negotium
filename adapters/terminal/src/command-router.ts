import { isVaultCommandLine, SELECTABLE_MODELS, type TopicDto } from "@negotium/core";
import { runTerminalVaultCommand, selectableEfforts } from "@/app-helpers";
import type { NegotiumClient } from "@/client";
import { type AppState, activeTopic, applyRuntimeEvent } from "@/state";

export interface TerminalCommandContext {
  client: NegotiumClient;
  state: AppState;
  queueRender: () => void;
  requestExit: () => void;
  abort: () => Promise<void>;
  openVault: (notice?: string) => Promise<void>;
  refreshTopics: (preferredTitle?: string) => Promise<void>;
  toggleTopics: (forceOpen?: boolean) => void;
  deriveTopic: (topic: TopicDto, copyHistory: boolean, name?: string) => Promise<void>;
  requestTopicDelete: (topic: TopicDto | undefined) => void;
  copy: () => Promise<void>;
}

export async function runTerminalCommand(
  commandLine: string,
  context: TerminalCommandContext,
): Promise<void> {
  if (isVaultCommandLine(commandLine)) {
    const outcome = await runTerminalVaultCommand(context.client, commandLine);
    if (outcome.kind === "open-manager") await context.openVault();
    else if (context.state.overlay === "vault") await context.openVault(outcome.notice);
    else {
      context.state = { ...context.state, notice: outcome.notice };
      context.queueRender();
    }
    return;
  }
  const [command = "", ...args] = commandLine.slice(1).trim().split(/\s+/);
  if (command === "quit" || command === "exit") {
    context.requestExit();
    return;
  }
  if (command === "abort") {
    await context.abort();
    return;
  }
  if (command === "help") {
    context.state = { ...context.state, overlay: "help" };
    context.queueRender();
    return;
  }
  if (command === "status") {
    context.state = { ...context.state, overlay: "status" };
    context.queueRender();
    return;
  }
  if (command === "model") {
    if (args.length > 0) {
      context.state = { ...context.state, notice: "Usage: /model" };
      context.queueRender();
      return;
    }
    const topic = activeTopic(context.state);
    if (!topic) {
      context.state = { ...context.state, notice: "No topic selected" };
      context.queueRender();
      return;
    }
    const currentModel = topic.effectiveModel ?? topic.defaultModel;
    const currentIndex = SELECTABLE_MODELS.findIndex(
      (candidate) => candidate.model === currentModel,
    );
    context.state = {
      ...context.state,
      overlay: "models",
      modelPickerIndex: Math.max(0, currentIndex),
    };
    context.queueRender();
    return;
  }
  if (command === "effort") {
    if (args.length > 0) {
      context.state = { ...context.state, notice: "Usage: /effort" };
      context.queueRender();
      return;
    }
    const topic = activeTopic(context.state);
    if (!topic) {
      context.state = { ...context.state, notice: "No topic selected" };
      context.queueRender();
      return;
    }
    const currentEffort = topic.effectiveEffort ?? topic.defaultEffort;
    const currentIndex = selectableEfforts(topic).indexOf(currentEffort);
    context.state = {
      ...context.state,
      overlay: "effort",
      effortPickerIndex: Math.max(0, currentIndex),
    };
    context.queueRender();
    return;
  }
  if (command === "public" || command === "private") {
    if (args.length > 0) {
      context.state = { ...context.state, notice: `Usage: /${command}` };
      context.queueRender();
      return;
    }
    const topic = activeTopic(context.state);
    if (!topic) {
      context.state = { ...context.state, notice: "No topic selected" };
      context.queueRender();
      return;
    }
    try {
      const notice = await context.client.setAccessMode(
        topic,
        command === "public" ? "shared" : "private",
      );
      await context.refreshTopics(topic.title);
      context.state = { ...context.state, notice };
    } catch (error) {
      context.state = {
        ...context.state,
        notice: error instanceof Error ? error.message : String(error),
      };
    }
    context.queueRender();
    return;
  }
  if (command === "compact") {
    const topic = activeTopic(context.state);
    if (!topic) {
      context.state = { ...context.state, notice: "No topic selected" };
      context.queueRender();
      return;
    }
    const queryId = `terminal-compact-${Date.now()}`;
    context.state = applyRuntimeEvent(
      { ...context.state, notice: "Compacting context…" },
      {
        type: "ai-status",
        topicId: topic.id,
        payload: { kind: "ai_active", queryId },
      },
    );
    context.queueRender();
    try {
      const notice = await context.client.compactTopic(topic);
      context.state = applyRuntimeEvent(
        { ...context.state, notice },
        {
          type: "ai-status",
          topicId: topic.id,
          payload: { kind: "ai_done", queryId },
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.state = applyRuntimeEvent(
        { ...context.state, notice: message },
        {
          type: "ai-status",
          topicId: topic.id,
          payload: { kind: "ai_error", queryId, error: message },
        },
      );
    }
    context.queueRender();
    return;
  }
  if (command === "topics") {
    context.toggleTopics(true);
    return;
  }
  if (command === "new") {
    if (args.length > 0) {
      context.state = { ...context.state, notice: "Usage: /new" };
      context.queueRender();
      return;
    }
    const topic = activeTopic(context.state);
    if (!topic) {
      context.state = { ...context.state, notice: "No topic selected" };
      context.queueRender();
      return;
    }
    try {
      const notice = await context.client.resetTopic(topic);
      context.state = { ...context.state, notice };
    } catch (error) {
      context.state = {
        ...context.state,
        notice: error instanceof Error ? error.message : String(error),
      };
    }
    context.queueRender();
    return;
  }
  if (command === "fork" || command === "spawn") {
    const topic = activeTopic(context.state);
    if (!topic) {
      context.state = { ...context.state, notice: "No topic selected" };
      context.queueRender();
      return;
    }
    await context.deriveTopic(topic, command === "fork", args.join(" ") || undefined);
    return;
  }
  if (command === "del") {
    if (args.length > 0) {
      context.state = { ...context.state, notice: "Usage: /del" };
      context.queueRender();
      return;
    }
    const topic = activeTopic(context.state);
    if (!topic) {
      context.state = { ...context.state, notice: "No topic selected" };
      context.queueRender();
      return;
    }
    context.requestTopicDelete(topic);
    return;
  }
  if (command === "copy") {
    if (args.length > 0) {
      context.state = { ...context.state, notice: "Usage: /copy" };
      context.queueRender();
      return;
    }
    void context.copy();
    return;
  }
  context.state = { ...context.state, notice: `Unknown command: /${command}` };
  context.queueRender();
}
