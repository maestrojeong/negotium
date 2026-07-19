import { resolve } from "node:path";

export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export function readEnvText(env: RuntimeEnvironment, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function parseRuntimePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
}

export function resolveRuntimeStateDir(options: {
  env: RuntimeEnvironment;
  envKey: string;
  fallbackRoot: string;
  fallbackName: string;
}): string {
  const configured = readEnvText(options.env, options.envKey);
  return configured ? resolve(configured) : resolve(options.fallbackRoot, options.fallbackName);
}

export function safeRuntimePathSegment(value: string, fallback: string, maxLength = 160): string {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLength);
  return cleaned || fallback;
}
