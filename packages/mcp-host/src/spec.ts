import { z } from "zod";

/**
 * MCP server transport kind.
 * - `stdio`: agents spawn the server per turn; the host does no process
 *   management (specs are just validated catalog entries).
 * - `http`:  the host launches a long-lived process that binds a port
 *   exposing `/sse` and/or `/mcp`.
 */
export type McpTransport = "stdio" | "http";

/** Catalog entry describing how to launch (or hand off) one MCP server. */
export interface McpServerSpec {
  /** Unique catalog name, e.g. "playwright". Also used in port file names. */
  key: string;
  transport: McpTransport;
  /** Executable to run. */
  command: string;
  /** Arguments; any literal "{port}" is substituted with the allocated port at launch. */
  args?: string[];
  /** Extra environment merged onto process.env for the child. */
  env?: Record<string, string>;
  cwd?: string;
  /** Ports scanned for a free slot. Required when transport === "http". */
  portRange?: { base: number; max: number };
  /** node = one shared process for the whole node; instance = one per instanceKey. */
  scope: "node" | "instance";
  /** How long to wait for the port to accept TCP after spawn. Default 20_000. */
  readyTimeoutMs?: number;
  /** Stop the instance after this long unused (http only). */
  idleEvictMs?: number;
  /** Periodic TCP probe interval; the instance is restarted on failure (http only). */
  healthIntervalMs?: number;
}

/** Snapshot of one live (or pseudo, for stdio) MCP instance. */
export interface McpInstance {
  key: string;
  /** "node" for node scope; caller-provided for instance scope. */
  instanceKey: string;
  /** Child process id. Absent for stdio pseudo-instances (nothing is spawned). */
  pid?: number;
  /** http only. */
  port?: number;
  /** http only: `http://127.0.0.1:{port}` (no path; endpoints live at /sse and /mcp). */
  url?: string;
  startedAt: string;
  lastUsedAt: string;
}

/** Keys must be safe as-is in file names and registry keys. */
const KEY_PATTERN = /^[a-zA-Z0-9._-]+$/;

const portSchema = z.number().int().min(1).max(65535);

/**
 * Runtime validator for {@link McpServerSpec}. Enforces the cross-field
 * invariant that http specs carry a well-formed portRange. Unknown keys are
 * stripped, so manifests survive forward-compatible extra fields.
 */
export const mcpServerSpecSchema: z.ZodType<McpServerSpec> = z
  .object({
    key: z
      .string()
      .min(1)
      .regex(KEY_PATTERN, "key may only contain [a-zA-Z0-9._-]")
      .refine((k) => k !== "." && k !== "..", "key may not be a dot path"),
    transport: z.enum(["stdio", "http"]),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    portRange: z.object({ base: portSchema, max: portSchema }).optional(),
    scope: z.enum(["node", "instance"]),
    readyTimeoutMs: z.number().int().positive().optional(),
    idleEvictMs: z.number().int().positive().optional(),
    healthIntervalMs: z.number().int().positive().optional(),
  })
  .superRefine((spec, ctx) => {
    if (spec.transport === "http") {
      if (!spec.portRange) {
        ctx.addIssue({
          code: "custom",
          path: ["portRange"],
          message: 'portRange is required when transport is "http"',
        });
      } else if (spec.portRange.max < spec.portRange.base) {
        ctx.addIssue({
          code: "custom",
          path: ["portRange"],
          message: "portRange.max must be >= portRange.base",
        });
      }
    }
  });
