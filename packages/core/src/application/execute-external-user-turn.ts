import { type TriggerTopicAiTurnOptions, triggerTopicAiTurn } from "#runtime/turn-runner";
import type { AgentKind } from "#types";

export interface ExecuteExternalUserTurnParams {
  topicId: string;
  userId: string;
  text: string;
  agent?: AgentKind;
  options?: TriggerTopicAiTurnOptions;
  /** Override used by adapter contract tests. */
  dispatch?: typeof triggerTopicAiTurn;
}

/** Application boundary for a user turn placed by an external runtime. */
export function executeExternalUserTurn(params: ExecuteExternalUserTurnParams): string | null {
  return (params.dispatch ?? triggerTopicAiTurn)(
    params.topicId,
    params.userId,
    params.text,
    params.agent,
    params.options,
  );
}
