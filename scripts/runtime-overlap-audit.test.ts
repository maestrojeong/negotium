import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRuntimeOverlap, lineSimilarity, overlapCapFailures } from "./runtime-overlap-audit";

describe("runtime overlap audit", () => {
  test("measures line similarity", () => {
    expect(lineSimilarity("a\nb\nc\n", "a\nb\nc\n")).toBe(1);
    expect(lineSimilarity("a\nb\nc\n", "a\nx\nc\n")).toBeCloseTo(2 / 3);
  });

  test("includes same-path and explicit alias pairs", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-overlap-"));
    const source = join(root, "source");
    const consumer = join(root, "consumer");
    await Promise.all([
      mkdir(join(source, "platform"), { recursive: true }),
      mkdir(join(source, "topics"), { recursive: true }),
      mkdir(join(consumer, "platform"), { recursive: true }),
      mkdir(join(consumer, "api"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(source, "platform/error.ts"), "export const value = 1;\n"),
      writeFile(join(consumer, "platform/error.ts"), "export const value = 1;\n"),
      writeFile(join(source, "topics/links.ts"), "export const link = 1;\n"),
      writeFile(join(consumer, "api/topic-links.ts"), "export const link = 1;\n"),
    ]);

    const report = await auditRuntimeOverlap(source, consumer);
    expect(report.compared).toBe(2);
    expect(report.samePathCompared).toBe(1);
    expect(report.aliasCompared).toBe(1);
    expect(report.exact).toBe(2);
    expect(report.pairs.map((pair) => pair.consumerPath)).toContain("api/topic-links.ts");
    expect(overlapCapFailures(report, { exact: 2, atLeast80: 2 })).toEqual([]);
    expect(overlapCapFailures(report, { exact: 1 })).toEqual(["exact=2 exceeds 1"]);
  });
});
