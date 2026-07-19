#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface RuntimeOverlapPair {
  sourcePath: string;
  consumerPath: string;
  similarity: number;
  exact: boolean;
}

export interface RuntimeOverlapReport {
  compared: number;
  samePathCompared: number;
  aliasCompared: number;
  exact: number;
  atLeast95: number;
  atLeast80: number;
  pairs: RuntimeOverlapPair[];
}

const DEFAULT_ALIASES: Record<string, string> = {
  "topics/links.ts": "api/topic-links.ts",
};

async function listTypeScriptFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(root, path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relative(root, path));
  }
  return files;
}

function lines(text: string): string[] {
  const normalized = text.replaceAll("\r\n", "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

/** Sørensen-Dice similarity over a line LCS, matching line-diff intuition. */
export function lineSimilarity(leftText: string, rightText: string): number {
  if (leftText === rightText) return 1;
  const left = lines(leftText);
  const right = lines(rightText);
  if (left.length === 0 && right.length === 0) return 1;
  let previous = new Uint32Array(right.length + 1);
  let current = new Uint32Array(right.length + 1);
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] =
        left[i - 1] === right[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  const lcs = previous[right.length] ?? 0;
  return (2 * lcs) / (left.length + right.length);
}

export async function auditRuntimeOverlap(
  sourceRoot: string,
  consumerRoot: string,
  aliases: Record<string, string> = DEFAULT_ALIASES,
): Promise<RuntimeOverlapReport> {
  const sourceFiles = await listTypeScriptFiles(sourceRoot);
  const consumerFiles = new Set(await listTypeScriptFiles(consumerRoot));
  const paths = sourceFiles.flatMap((sourcePath) => {
    const samePath = consumerFiles.has(sourcePath) ? [sourcePath] : [];
    const alias = aliases[sourcePath];
    return [...samePath, ...(alias && consumerFiles.has(alias) ? [alias] : [])].map(
      (consumerPath) => ({ sourcePath, consumerPath }),
    );
  });
  const pairs = await Promise.all(
    paths.map(async ({ sourcePath, consumerPath }) => {
      const [source, consumer] = await Promise.all([
        readFile(resolve(sourceRoot, sourcePath), "utf8"),
        readFile(resolve(consumerRoot, consumerPath), "utf8"),
      ]);
      return {
        sourcePath,
        consumerPath,
        similarity: lineSimilarity(source, consumer),
        exact: source === consumer,
      };
    }),
  );
  pairs.sort((left, right) => right.similarity - left.similarity);
  return {
    compared: pairs.length,
    samePathCompared: pairs.filter((pair) => pair.sourcePath === pair.consumerPath).length,
    aliasCompared: pairs.filter((pair) => pair.sourcePath !== pair.consumerPath).length,
    exact: pairs.filter((pair) => pair.exact).length,
    atLeast95: pairs.filter((pair) => pair.similarity >= 0.95).length,
    atLeast80: pairs.filter((pair) => pair.similarity >= 0.8).length,
    pairs,
  };
}

export function overlapCapFailures(
  report: RuntimeOverlapReport,
  caps: Partial<Pick<RuntimeOverlapReport, "exact" | "atLeast95" | "atLeast80">>,
): string[] {
  return (Object.entries(caps) as Array<[keyof typeof caps, number]>).flatMap(
    ([metric, maximum]) =>
      report[metric] > maximum ? [`${metric}=${report[metric]} exceeds ${maximum}`] : [],
  );
}

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  if (!value) throw new Error(`${prefix}<path> is required`);
  return resolve(value);
}

function optionalNumberArg(name: string): number | undefined {
  const prefix = `--${name}=`;
  const raw = process.argv
    .slice(2)
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${prefix}<non-negative integer>`);
  return value;
}

if (import.meta.main) {
  const report = await auditRuntimeOverlap(requiredArg("source"), requiredArg("consumer"));
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `same-path=${report.samePathCompared} aliases=${report.aliasCompared} total=${report.compared} exact=${report.exact} >=95%=${report.atLeast95} >=80%=${report.atLeast80}`,
    );
    for (const pair of report.pairs.filter((candidate) => candidate.similarity >= 0.8)) {
      const paths =
        pair.sourcePath === pair.consumerPath
          ? pair.sourcePath
          : `${pair.sourcePath} -> ${pair.consumerPath}`;
      console.log(`${(pair.similarity * 100).toFixed(1)}% ${paths}`);
    }
  }
  const failures = overlapCapFailures(report, {
    exact: optionalNumberArg("max-exact"),
    atLeast95: optionalNumberArg("max-95"),
    atLeast80: optionalNumberArg("max-80"),
  });
  if (failures.length > 0) throw new Error(`runtime overlap regression: ${failures.join(", ")}`);
}
