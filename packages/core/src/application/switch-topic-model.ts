import { switchApiTopicAgent } from "#agents/api-topic-agent-switch";
import { checkAgentModelAuth } from "#agents/auth-check";
import { selectableModel } from "#agents/model-catalog";
import { WsHub } from "#bus";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import { getTopic } from "#storage/api-topics";

export type SwitchTopicModelResult =
  | { ok: true; model: string; text: string }
  | { ok: false; error: string };

export interface SwitchTopicModelParams {
  topicId: string;
  userId: string;
  model: string;
}

/**
 * Apply one user-selected model to a topic. The model token determines its
 * runtime owner internally, so channel adapters never implement or expose a
 * separate agent picker. Cross-runtime switches preserve portable history via
 * the same rollout bridge used by the topic-config MCP tools.
 */
export function switchTopicModel(params: SwitchTopicModelParams): SwitchTopicModelResult {
  const topic = getTopic(params.topicId);
  if (!topic) return { ok: false, error: "Topic not found" };
  const owner = topic.participants.some(
    (participant) => participant.userId === params.userId && participant.role === "owner",
  );
  if (!owner) return { ok: false, error: "Only topic owners can change the model" };
  if (!topic.agent) return { ok: false, error: "This topic has no AI model" };

  const target = selectableModel(params.model);
  if (!target) return { ok: false, error: `Unknown model: ${params.model.trim() || "(empty)"}` };
  const auth = checkAgentModelAuth(target.agent, target.model, undefined, params.userId);
  if (!auth.ok) return { ok: false, error: auth.error };

  const currentAgent = topic.agent;
  const currentConfig = getApiTopicConfig(topic.id) ?? {};
  const nextConfig = {
    ...currentConfig,
    model: target.model,
    effort: undefined,
    agentLocked: true,
    modelLocked: true,
    effortLocked: undefined,
  };

  if (currentAgent !== target.agent) {
    const switched = switchApiTopicAgent({
      topicId: topic.id,
      topicTitle: topic.title,
      userId: params.userId,
      fromAgent: currentAgent,
      agent: target.agent,
      cwd: resolveTopicWorkspaceDir(topic.id),
      config: nextConfig,
      defaultModel: topic.defaultModel,
      defaultEffort: topic.defaultEffort,
      reason: "user-model-switch",
    });
    if (!switched.ok) return { ok: false, error: switched.error };
  } else {
    setApiTopicConfig(topic.id, nextConfig);
    // A provider session is not owned by one model. Codex, Claude, and Maestro
    // all accept the selected model when resuming, so keep the durable resume
    // key and let the next turn continue the same rollout with the new model.
    // Clearing it here silently discarded native tool/history structure and
    // made an ordinary model change look like `/new`.
  }

  WsHub.get().broadcastTopicUpdated(topic.id);
  return {
    ok: true,
    model: target.model,
    text: `Model set to '${target.model}'. Applies from the next turn.`,
  };
}
