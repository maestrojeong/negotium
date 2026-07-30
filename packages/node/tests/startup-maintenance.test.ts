import { describe, expect, it } from "bun:test";
import { runSingletonStartupMaintenance } from "../src/startup-maintenance";

describe("runSingletonStartupMaintenance", () => {
  it("reaps untracked browsers before migrating conversations", () => {
    const events: string[] = [];
    runSingletonStartupMaintenance({
      reapBrowsers: (liveDirs) => {
        events.push(`reap:${[...liveDirs].length}`);
      },
      migrateConversations: () => {
        events.push("migrate");
      },
    });

    expect(events).toEqual(["reap:0", "migrate"]);
  });
});
