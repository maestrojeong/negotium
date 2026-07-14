import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { defaultManifestFile } from "#paths";
import { type McpServerSpec, mcpServerSpecSchema } from "#spec";

const manifestEntrySchema = z.object({
  spec: mcpServerSpecSchema,
  enabled: z.boolean(),
});

const manifestFileSchema = z.object({
  version: z.literal(1),
  servers: z.array(manifestEntrySchema),
});

interface ManifestEntry {
  spec: McpServerSpec;
  enabled: boolean;
}

/**
 * Persistent per-node registry of the MCP servers assigned to this node.
 *
 * Invariants:
 * - Keys are unique; `add` throws on duplicates rather than silently replacing.
 * - Disabled specs stay listed (visible in `list`) but consumers (McpHost)
 *   must refuse to launch them.
 * - Every mutation is persisted synchronously with an atomic tmp+rename write,
 *   so a fresh `McpManifest` on the same file always observes the last change.
 * - A corrupt or schema-invalid file throws at construction instead of being
 *   silently clobbered on the next save.
 */
export class McpManifest {
  private readonly file: string;
  private readonly entries = new Map<string, ManifestEntry>();

  constructor(opts?: { file?: string }) {
    this.file = opts?.file ?? defaultManifestFile();
    this.load();
  }

  /** All specs, enabled or not, in insertion order. Returns defensive copies. */
  list(): McpServerSpec[] {
    return [...this.entries.values()].map((e) => structuredClone(e.spec));
  }

  get(key: string): McpServerSpec | undefined {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry.spec) : undefined;
  }

  /** Register a spec (validated). Throws on duplicate key. New specs start enabled. */
  add(spec: McpServerSpec): void {
    const parsed = mcpServerSpecSchema.parse(spec);
    if (this.entries.has(parsed.key)) {
      throw new Error(`MCP spec already exists in manifest: "${parsed.key}"`);
    }
    this.entries.set(parsed.key, { spec: parsed, enabled: true });
    this.save();
  }

  remove(key: string): boolean {
    const removed = this.entries.delete(key);
    if (removed) this.save();
    return removed;
  }

  /** Toggle launchability without losing the catalog entry. Throws on unknown key. */
  setEnabled(key: string, enabled: boolean): void {
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Unknown MCP spec: "${key}"`);
    if (entry.enabled === enabled) return;
    entry.enabled = enabled;
    this.save();
  }

  /** False for unknown keys as well as explicitly disabled ones. */
  isEnabled(key: string): boolean {
    return this.entries.get(key)?.enabled ?? false;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let parsed: z.infer<typeof manifestFileSchema>;
    try {
      parsed = manifestFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (e) {
      throw new Error(
        `Invalid MCP manifest at ${this.file}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    for (const entry of parsed.servers) {
      if (this.entries.has(entry.spec.key)) {
        throw new Error(`Duplicate MCP spec key in manifest ${this.file}: "${entry.spec.key}"`);
      }
      this.entries.set(entry.spec.key, entry);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const payload = {
      version: 1 as const,
      servers: [...this.entries.values()],
    };
    // Atomic write: a crash mid-write must never leave a truncated manifest.
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
