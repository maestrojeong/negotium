/** Default latest-request context occupancy that triggers a warning. */
export const DEFAULT_CONTEXT_WARNING_RATIO = 0.8;

/** Provider-neutral context occupancy input for public consumers. */
export interface ContextOccupancy {
  contextTokens?: number | null;
  contextWindow?: number | null;
}

/** Minimal Claude request usage shape; intentionally independent of the Anthropic SDK types. */
export interface ClaudeRequestTokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface ContextWarningTextOptions {
  topicTitle: string;
  usage: ContextOccupancy;
  /** Whether this consumer implements the compact command. Defaults to true. */
  supportsCompact?: boolean;
  compactCommand?: string;
  newCommand?: string;
}

export interface ContextWarningOptions extends ContextWarningTextOptions {
  /** Caller-owned dedupe key, normally scoped to one user/topic session. */
  key: string;
  thresholdRatio?: number;
}

/** Caller-owned state. Create one per runtime/store boundary to avoid global key collisions. */
export interface ContextWarningState {
  readonly warnedKeys: Set<string>;
}

export function createContextWarningState(
  warnedKeys: Set<string> = new Set(),
): ContextWarningState {
  return { warnedKeys };
}

/** Latest-request context occupancy, or null when the provider did not report valid values. */
export function contextUsageRatio(usage: ContextOccupancy): number | null {
  const used = usage.contextTokens;
  const window = usage.contextWindow;
  if (
    used === undefined ||
    used === null ||
    window === undefined ||
    window === null ||
    !Number.isFinite(used) ||
    !Number.isFinite(window) ||
    used < 0 ||
    window <= 0
  ) {
    return null;
  }
  return used / window;
}

export function shouldWarnForContext(
  usage: ContextOccupancy,
  thresholdRatio = DEFAULT_CONTEXT_WARNING_RATIO,
): boolean {
  if (!Number.isFinite(thresholdRatio) || thresholdRatio < 0) return false;
  const ratio = contextUsageRatio(usage);
  return ratio !== null && ratio >= thresholdRatio;
}

export function formatContextTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0K";
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1000)}K`;
}

/** Build the shared warning copy while adapting command guidance to consumer capabilities. */
export function buildContextWarningText(options: ContextWarningTextOptions): string {
  const ratio = contextUsageRatio(options.usage) ?? 0;
  const used = options.usage.contextTokens ?? 0;
  const window = options.usage.contextWindow ?? 0;
  const compactCommand = options.compactCommand ?? "/compact";
  const newCommand = options.newCommand ?? "/new";
  const supportsCompact = options.supportsCompact ?? true;
  const guidance = supportsCompact
    ? `이 토픽에서 ${compactCommand} 를 입력하면 핵심 맥락을 요약해 이어가면서 context를 줄입니다. 완전히 새로 시작하려면 ${newCommand} 를 사용하세요.\n\n두 명령 모두 지금까지 주고받은 보이는 대화 내역은 그대로 유지합니다.`
    : `완전히 새 context로 시작하려면 ${newCommand} 를 사용하세요. 지금까지 주고받은 보이는 대화 내역은 그대로 유지합니다.`;

  return (
    `⚠️ "${options.topicTitle}" context가 ${Math.round(ratio * 100)}% 찼어요 ` +
    `(${formatContextTokenCount(used)} / ${formatContextTokenCount(window)} 토큰)\n\n` +
    guidance
  );
}

/**
 * Return and dedupe the next warning using state owned by the caller.
 * The key is marked only when the threshold is actually reached.
 */
export function nextContextWarning(
  state: ContextWarningState,
  options: ContextWarningOptions,
): string | null {
  if (!shouldWarnForContext(options.usage, options.thresholdRatio)) return null;
  if (state.warnedKeys.has(options.key)) return null;
  state.warnedKeys.add(options.key);
  return buildContextWarningText(options);
}

export function clearContextWarning(state: ContextWarningState, key: string): void {
  state.warnedKeys.delete(key);
}

/** Latest Claude request context tokens using the same fields Negotium providers receive. */
export function claudeRequestContextTokens(usage: ClaudeRequestTokenUsage): number | null {
  const values = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.output_tokens,
  ];
  if (values.every((value) => value === undefined || value === null)) return null;
  if (
    values.some(
      (value) => value !== undefined && value !== null && (!Number.isFinite(value) || value < 0),
    )
  ) {
    return null;
  }
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
