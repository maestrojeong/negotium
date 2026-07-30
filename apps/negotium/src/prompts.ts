export type {
  AgentDef,
  PromptBuilderHost,
  PromptBuilders,
  PromptExtraSection,
  PromptSectionContext,
  PromptSectionSlot,
  PromptTemplateRequest,
  SessionPromptKind,
  SessionSystemPromptOpts,
} from "@negotium/core/prompts";
export {
  buildChannelSystemPrompt,
  buildManagerSystemPrompt,
  buildMemoryPromptSection,
  buildTopicSystemPrompt,
  createPromptBuilders,
  loadAgentPrompt,
} from "@negotium/core/prompts";
