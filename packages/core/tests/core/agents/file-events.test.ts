import { describe, expect, test } from "bun:test";
import { extractFileEvents } from "#media/file-events";

describe("extractFileEvents", () => {
  test("extracts explicit FILE tags", () => {
    expect([...extractFileEvents("done [FILE:/tmp/report.pdf]", "result")]).toEqual([
      { type: "file", path: "/tmp/report.pdf", source: "result", origin: "tag" },
    ]);
  });

  test("does not treat markdown links or bare paths as file send intent", () => {
    const text = [
      "See [source](/Users/me/project/src/app.ts:12)",
      "and /Users/me/project/out/report.pdf for context.",
    ].join("\n");

    expect([...extractFileEvents(text, "result")]).toEqual([]);
  });
});
