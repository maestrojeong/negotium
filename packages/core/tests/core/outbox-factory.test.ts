import { describe, expect, test } from "bun:test";
import { createOutboxFileOps, type OutboxLogger } from "#outbox/file-ops";
import { createOutboxWatchOps } from "#outbox/utils";

function logger(errors: Array<{ fields: Record<string, unknown>; message: string }>): OutboxLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error(fields, message) {
      errors.push({ fields, message });
    },
  };
}

describe("outbox host factory", () => {
  test("uses caller-owned parsing and logging dependencies", () => {
    const firstErrors: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const secondErrors: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const first = createOutboxFileOps({ logger: logger(firstErrors), readJsonlLines: () => [] });
    const second = createOutboxFileOps({ logger: logger(secondErrors), readJsonlLines: () => [] });

    expect(first.parseOutboxLine("invalid", "first")).toBeNull();
    expect(firstErrors).toHaveLength(1);
    expect(firstErrors[0]?.fields).toMatchObject({ label: "first", line: "invalid" });
    expect(secondErrors).toHaveLength(0);

    expect(second.parseOutboxLine<{ ok: boolean }>('{"ok":true}', "second")).toEqual({
      ok: true,
    });
    expect(secondErrors).toHaveLength(0);
  });

  test("watch factory uses the caller-owned logger", async () => {
    const errors: string[] = [];
    const ops = createOutboxWatchOps({
      logger: {
        error: (_fields, message) => errors.push(message),
        warn: () => {},
      },
    });
    const flush = ops.debouncedFlush(
      async () => {
        throw new Error("boom");
      },
      "consumer",
      0,
    );

    flush();
    await Bun.sleep(10);
    expect(errors).toEqual(["consumer: Unhandled error"]);
  });
});
