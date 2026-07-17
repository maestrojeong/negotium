import {
  abortRoom,
  buildStdioMcpServer,
  getRoomQuery,
  getTopic,
  purgeTopicLogs,
  registerBackgroundSessionProvider,
  registerRuntimeMcpServer,
  resolveTopicWorkspaceDir,
  rotateTopicLogs,
} from "@negotium/core";
import type { CronDispatch } from "#scheduler";

export type CronAuthorizationAction = "cron:admin";

export interface CronAuthorizationResource {
  type: "cron";
}

/** Host-owned services required when the cron module is embedded. */
export interface CronHost {
  dispatch?: CronDispatch;
  getTopic: typeof getTopic;
  getRoomQuery: typeof getRoomQuery;
  abortRoom: typeof abortRoom;
  resolveTopicWorkspaceDir: typeof resolveTopicWorkspaceDir;
  purgeTopicLogs: typeof purgeTopicLogs;
  rotateTopicLogs: typeof rotateTopicLogs;
  registerRuntimeMcpServer: typeof registerRuntimeMcpServer;
  registerBackgroundSessionProvider: typeof registerBackgroundSessionProvider;
  buildStdioMcpServer: typeof buildStdioMcpServer;
  authorize?(
    userId: string,
    action: CronAuthorizationAction,
    resource: CronAuthorizationResource,
  ): boolean;
}

const defaultHost: CronHost = {
  getTopic,
  getRoomQuery,
  abortRoom,
  resolveTopicWorkspaceDir,
  purgeTopicLogs,
  rotateTopicLogs,
  registerRuntimeMcpServer,
  registerBackgroundSessionProvider,
  buildStdioMcpServer,
};

let activeHost: CronHost = defaultHost;

export function cronHost(): CronHost {
  return activeHost;
}

/** Configure one embedded cron module. Returns a disposer for shutdown/tests. */
export function configureCronHost(overrides: Partial<CronHost>): () => void {
  const previous = activeHost;
  activeHost = { ...previous, ...overrides };
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    activeHost = previous;
  };
}
