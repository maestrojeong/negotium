import { logger } from "#platform/logger";
import type { AgentKind } from "#types";

export interface CronSessionRef {
  sessionId: string;
  ownerUserId: string;
}

export type CronSessionProvider = (topicId: string, agent: AgentKind) => CronSessionRef | null;

const providers: Array<{ provider: CronSessionProvider }> = [];

export function getRegisteredCronSession(topicId: string, agent: AgentKind): CronSessionRef | null {
  const registration = providers.at(-1);
  if (!registration) return null;
  try {
    return registration.provider(topicId, agent);
  } catch (error) {
    logger.warn({ err: error, topicId, agent }, "cron-session: provider lookup failed");
    return null;
  }
}

/** Register the optional Cron module's session lookup without coupling core to the module. */
export function registerCronSessionProvider(next: CronSessionProvider): () => void {
  const registration = { provider: next };
  providers.push(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = providers.indexOf(registration);
    if (index >= 0) providers.splice(index, 1);
  };
}
