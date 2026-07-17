import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { configureCronHost, cronHost } from "../src/host";
import { configureCronDatabase, createCronJob, ensureCronSchema, getCronJob } from "../src/store";

describe("cron embedding ports", () => {
  test("scopes host overrides and restores standalone defaults", () => {
    const originalGetTopic = cronHost().getTopic;
    const restore = configureCronHost({
      getTopic: ((topicId: string) => ({ id: topicId, agent: "codex" })) as typeof originalGetTopic,
      authorize: (userId, action, resource) =>
        userId === "admin" && action === "cron:admin" && resource.type === "cron",
    });
    try {
      expect(cronHost().getTopic("embedded-topic")?.agent).toBe("codex");
      expect(cronHost().authorize?.("admin", "cron:admin", { type: "cron" })).toBe(true);
    } finally {
      restore();
    }
    expect(cronHost().getTopic).toBe(originalGetTopic);
  });

  test("stores cron state in an injected SQLite handle", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE api_topics (id TEXT PRIMARY KEY, agent TEXT);
      INSERT INTO api_topics (id, agent) VALUES ('embedded-topic', 'codex');
    `);
    const restore = configureCronDatabase(database);
    try {
      ensureCronSchema();
      const job = createCronJob({
        name: "embedded-job",
        ownerUserId: "embedded-user",
        topicId: "embedded-topic",
        prompt: "Run inside the host process",
        schedule: "0 9 * * *",
        timezone: "UTC",
      });
      expect(getCronJob(job.id)?.ownerUserId).toBe("embedded-user");
    } finally {
      restore();
      database.close();
    }
  });
});
