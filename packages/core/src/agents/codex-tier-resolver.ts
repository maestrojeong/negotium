import {
  bundledCodexModelCachePath,
  readCompatibleCodexModelCache,
} from "#agents/codex-native-multi-agent";
import { hostedCodexAuthFilePath } from "#agents/execution-host";
import { logger } from "#platform/logger";

export const CODEX_TIER_FALLBACKS = {
  astra: "gpt-6-astra",
  sol: "gpt-6-sol",
  luna: "gpt-6-luna",
  terra: "gpt-6.1-terra",
} as const;

export type CodexTier = keyof typeof CODEX_TIER_FALLBACKS;

const warnedCachePaths = new Set<string>();
const warnedUnpricedSlugs = new Set<string>();
const pricedSlugs = new Set([
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6.1-terra",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
]);

/** Choose Codex's highest-priority visible model for each supported tier. */
export function codexTiersFromCache(cache: unknown): Partial<Record<CodexTier, string>> {
  const result: Partial<Record<CodexTier, string>> = {};
  const priorities: Partial<Record<CodexTier, number>> = {};
  if (!cache || typeof cache !== "object" || !("models" in cache)) return result;
  const models = (cache as { models?: unknown }).models;
  if (!Array.isArray(models)) return result;

  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const { slug, visibility, priority } = model as Record<string, unknown>;
    if (typeof slug !== "string" || visibility !== "list") continue;
    if (typeof priority !== "number" || !Number.isFinite(priority)) continue;
    const suffix = slug.slice(slug.lastIndexOf("-") + 1);
    if (!Object.hasOwn(CODEX_TIER_FALLBACKS, suffix)) continue;
    const tier = suffix as CodexTier;
    if (priorities[tier] === undefined || priority < priorities[tier]) {
      priorities[tier] = priority;
      result[tier] = slug;
    }
  }
  return result;
}

export function resolveCodexTierModel(
  tier: CodexTier,
  cachePath = process.env.NEGOTIUM_CODEX_MODELS_CACHE_FILE ??
    bundledCodexModelCachePath(hostedCodexAuthFilePath()),
): string {
  try {
    const selected = codexTiersFromCache(readCompatibleCodexModelCache(cachePath).parsed)[tier];
    if (selected) {
      if (!pricedSlugs.has(selected) && !warnedUnpricedSlugs.has(selected)) {
        warnedUnpricedSlugs.add(selected);
        logger.warn({ tier, model: selected }, "Codex tier model has no token-stats price");
      }
      return selected;
    }
  } catch (error) {
    if (!warnedCachePaths.has(cachePath)) {
      warnedCachePaths.add(cachePath);
      logger.warn({ err: error, cachePath }, "Codex tier cache unavailable; using fallback ids");
    }
  }
  return CODEX_TIER_FALLBACKS[tier];
}
