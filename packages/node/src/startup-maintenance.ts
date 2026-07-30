export interface SingletonStartupMaintenance {
  reapBrowsers: (liveUserDataDirs: Iterable<string>) => void;
  migrateConversations: () => void;
}

export function runSingletonStartupMaintenance(maintenance: SingletonStartupMaintenance): void {
  maintenance.reapBrowsers([]);
  maintenance.migrateConversations();
}
