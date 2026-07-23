#!/usr/bin/env bun

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { argv, exit } from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { SHARED_WIKI_DIR } from "#platform/config";
import {
  wikiBriefStorageKey,
  wikiSummaryFilename,
  wikiSummarySlug,
} from "#storage/wiki-summary-names";

// --- CLI parsing -----------------------------------------------------------

export type WikiSurface = "all" | "wiki" | "skills";

export interface WikiTopicBrief {
  briefMd: string;
  latestSummaryMd?: string;
  summaryDate?: string;
  updatedAt: string;
}

export interface WikiMcpHost {
  wikiRoot: string;
  getTopicBrief?(topicId: string): WikiTopicBrief | null;
  setTopicBrief?(
    topicId: string,
    fields: { briefMd?: string; latestSummaryMd?: string; summaryDate?: string },
  ): void;
}

export interface WikiMcpContext {
  userId: string;
  topicId?: string;
  surface?: WikiSurface;
}

interface WikiRuntime extends Required<Pick<WikiMcpContext, "userId" | "surface">> {
  topicId?: string;
  host: WikiMcpHost;
  wikiDir: string;
  skillsDir: string;
  topicsDir: string;
  summariesDir: string;
  articlesDir: string;
  archiveDir: string;
}

const wikiRuntime = new AsyncLocalStorage<WikiRuntime>();

function runtime(): WikiRuntime {
  const current = wikiRuntime.getStore();
  if (!current) throw new Error("wiki MCP handler called without a runtime context");
  return current;
}

function parseArgv(): { userId: string; topicId?: string; surface: WikiSurface } {
  let userId = "default";
  let topicId: string | undefined;
  let surface: WikiSurface = "all";

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--user-id=")) userId = a.slice("--user-id=".length);
    else if (a.startsWith("--topic-id=")) topicId = a.slice("--topic-id=".length);
    else if (a === "--surface=wiki") surface = "wiki";
    else if (a === "--surface=skills") surface = "skills";
  }

  return { userId, topicId, surface };
}

// --- Helpers ---------------------------------------------------------------

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function safeExt<T, K extends string = string>(
  obj: Record<string, unknown> | undefined | null,
  keys: readonly K[],
  fallback: T,
): T {
  if (!obj || typeof obj !== "object") return fallback;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null) return value as T;
  }
  return fallback;
}

function topicNameFrom(topicIdStr: string): string {
  return topicIdStr;
}

function slugify(topic: string): string {
  return wikiSummarySlug(topic);
}

// --- Tool handlers (file-based) -------------------------------------------

function wikiQuery(args: Record<string, unknown>): CallToolResult {
  const question = safeExt(args, ["question", "query", "q", "text"], "");
  const query = question.toLowerCase();

  const results: string[] = [];
  const scored: { score: number; path: string; text: string }[] = [];

  function scan(dir: string, label: string): void {
    ensureDir(dir);
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const sub = join(dir, entry.name);
          // Limit depth: only go one level deep for articles/skills
          if (label === "articles" || label === "skills") {
            try {
              for (const f of readdirSync(sub, { withFileTypes: true })) {
                if (!f.isFile() || !f.name.endsWith(".md")) continue;
                const fp = join(sub, f.name);
                try {
                  const text = readFileSync(fp, "utf-8");
                  scored.push({
                    score: scoreMatch(text),
                    path: `${label}/${entry.name}/${f.name}`,
                    text,
                  });
                } catch {
                  /* skip unreadable */
                }
              }
            } catch {
              /* skip unreadable dir */
            }
          }
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const fp = join(dir, entry.name);
          try {
            const text = readFileSync(fp, "utf-8");
            scored.push({ score: scoreMatch(text), path: `${label}/${entry.name}`, text });
          } catch {
            /* skip unreadable */
          }
        }
      }
    } catch {
      /* dir may not exist */
    }
  }

  function scoreMatch(text: string): number {
    const lower = text.toLowerCase();
    let score = 0;
    const words = query.split(/\s+/).filter(Boolean);
    for (const w of words) {
      if (lower.includes(w)) {
        score += w.length >= 3 ? 3 : 1;
        // Bonus for title match (first line starts with #)
        const firstLine = lower.split("\n")[0];
        if (firstLine.startsWith("#") && firstLine.includes(w)) score += 5;
      }
    }
    return score;
  }

  scan(runtime().articlesDir, "articles");
  // Skills are node-local runtime knowledge, not canonical workspace memory.
  // Keep the legacy all-in-one server compatible while ensuring the explicit
  // wiki surface cannot read a node's skill library.
  if (runtime().surface === "all") scan(runtime().skillsDir, "skills");
  scan(runtime().topicsDir, "topic");
  scan(runtime().summariesDir, "summaries");

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 8);

  if (top.length === 0) {
    results.push("No matching wiki articles found.");
  } else {
    results.push(`Found ${top.length} matching result(s):\n`);
    for (const { path, text } of top) {
      // Extract title from first heading
      const titleLine = text.split("\n").find((l) => l.startsWith("#"));
      const title = titleLine ? titleLine.replace(/^#+\s*/, "") : basename(path, ".md");
      // Truncate body to 400 chars
      const body = text
        .replace(/^---[\s\S]*?---\n?/, "")
        .replace(/^#.*$/m, "")
        .trim()
        .slice(0, 400);
      results.push(
        `## ${title}\nPath: ${path}\n\n${body}${text.length > 400 ? "\n...(truncated)" : ""}\n`,
      );
    }
  }

  return { content: [{ type: "text", text: results.join("\n") }] };
}

function wikiTopicBrief(args: Record<string, unknown>): CallToolResult {
  const rawTopic = safeExt<string | undefined>(
    args,
    ["topic", "topicName", "topicId"],
    runtime().topicId,
  );
  if (!rawTopic) {
    return {
      content: [{ type: "text", text: "No topic specified (provide --topic-id or topic arg)." }],
    };
  }

  const getTopicBrief = runtime().host.getTopicBrief;
  if (runtime().topicId && getTopicBrief) {
    try {
      const brief = getTopicBrief(rawTopic);
      if (!brief) {
        return { content: [{ type: "text", text: `No brief found for topic: ${rawTopic}` }] };
      }
      const lines = [
        `# Topic Brief: ${topicNameFrom(rawTopic)}`,
        "",
        brief.briefMd || "(empty brief)",
      ];
      if (brief.latestSummaryMd) {
        lines.push("", "## Latest Summary", "", brief.latestSummaryMd);
      }
      if (brief.summaryDate) {
        lines.push("", `Summary date: ${brief.summaryDate}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch {
      return { content: [{ type: "text", text: `Could not read topic brief for: ${rawTopic}` }] };
    }
  }

  return { content: [{ type: "text", text: `No topic brief found for: ${rawTopic}` }] };
}

function wikiLastConversation(args: Record<string, unknown>): CallToolResult {
  const rawTopic = safeExt<string | undefined>(
    args,
    ["topic", "topicName", "topicId"],
    runtime().topicId,
  );
  const turns = safeExt(args, ["turns", "limit", "n"], 5);
  const maxTurns = Math.min(Math.max(1, Number(turns) || 5), 10);

  if (!rawTopic) {
    return { content: [{ type: "text", text: "No topic specified." }] };
  }

  const name = slugify(topicNameFrom(rawTopic));

  // Try per-topic archive dir first, then flat file
  const archiveDir = resolve(runtime().archiveDir, name);
  ensureDir(archiveDir);

  try {
    // List archive files sorted by name (which should be date-sorted)
    let files = readdirSync(archiveDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
    if (files.length === 0) {
      // Try flat archive
      ensureDir(runtime().archiveDir);
      files = readdirSync(runtime().archiveDir)
        .filter((f) => f.startsWith(name) && f.endsWith(".jsonl"))
        .sort()
        .reverse();
    }
    if (files.length === 0) {
      return { content: [{ type: "text", text: `No archive found for topic: ${rawTopic}` }] };
    }

    // Read most recent archive file
    const actualPath = files[0].includes("/")
      ? files[0]
      : resolve(
          readdirSync(archiveDir).includes(files[0]) ? archiveDir : runtime().archiveDir,
          files[0],
        );

    try {
      const raw = readFileSync(actualPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);

      // Reconstruct turns from UnifiedEvent JSONL: pair user_message with following text/result
      const turns: string[] = [];
      let currentUser = "";
      let currentAssistant = "";

      const truncate = (s: string, max: number) =>
        s.length > max ? `${s.slice(0, max)}\n...(truncated)` : s;

      const flush = () => {
        if (currentUser || currentAssistant) {
          turns.push(
            `**User**: ${truncate(currentUser || "(no prompt)", 500)}\n\n**Assistant**: ${truncate(currentAssistant || "(no response)", 1000)}`,
          );
          currentUser = "";
          currentAssistant = "";
        }
      };

      for (const line of lines) {
        try {
          // Archives are written by archiveTopicMessages → TopicArchiveTranscriptRecord:
          // { type: "message", role: "user"|"assistant"|"system", text: "..." }
          const record = JSON.parse(line) as { type: string; role?: string; text?: string };
          if (record.type === "message" && record.role === "user") {
            flush();
            currentUser = record.text ?? "";
          } else if (record.type === "message" && record.role === "assistant") {
            currentAssistant += record.text ?? "";
          }
        } catch {
          // skip malformed lines
        }
      }
      flush();

      if (turns.length === 0) {
        return { content: [{ type: "text", text: `Archive file found but no valid entries.` }] };
      }

      const recent = turns.slice(-maxTurns);
      return {
        content: [
          {
            type: "text",
            text: `## Last ${recent.length} turns from "${rawTopic}" (${files[0]})\n\n${recent.join("\n\n---\n\n")}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: `Could not read archive for: ${rawTopic}` }] };
    }
  } catch {
    return { content: [{ type: "text", text: `No archive found for: ${rawTopic}` }] };
  }
}

function skillQuery(args: Record<string, unknown>): CallToolResult {
  const question = safeExt(args, ["question", "query", "q"], "");
  const query = question.toLowerCase();

  ensureDir(runtime().skillsDir);

  const matches: { name: string; path: string; desc: string }[] = [];

  try {
    for (const entry of readdirSync(runtime().skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = resolve(runtime().skillsDir, entry.name, "skill.md");
      try {
        const text = readFileSync(skillFile, "utf-8");
        const lower = text.toLowerCase();
        let score = 0;
        for (const w of query.split(/\s+/).filter(Boolean)) {
          if (lower.includes(w)) score += w.length >= 3 ? 3 : 1;
        }
        if (score > 0) {
          // Extract name/description from frontmatter
          const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
          let name = entry.name;
          let desc = "";
          if (fmMatch) {
            const fm = fmMatch[1];
            const nMatch = fm.match(/^name:\s*(.+)$/m);
            const dMatch = fm.match(/^description:\s*(.+)$/m);
            if (nMatch) name = nMatch[1].trim();
            if (dMatch) desc = dMatch[1].trim();
          }
          matches.push({ name, path: `skills/${entry.name}/skill.md`, desc });
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* dir may not exist */
  }

  if (matches.length === 0) {
    return { content: [{ type: "text", text: "No matching skills found." }] };
  }

  const lines = matches.map((m) => `- **${m.name}** (${m.path})${m.desc ? ` — ${m.desc}` : ""}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function skillSave(args: Record<string, unknown>): CallToolResult {
  const name = safeExt(args, ["name", "skill_name"], "");
  const content: string = safeExt(args, ["content", "text", "body"], "");

  if (!name) return { content: [{ type: "text", text: "Missing skill name." }] };
  if (!content) return { content: [{ type: "text", text: "Missing skill content." }] };

  function extractGotchas(md: string): string[] {
    // No `m` flag: `$` anchors to end-of-string so lazy [\s\S]*? isn't fooled
    // by mid-section newlines the way it would be in multiline mode.
    const m = md.match(/(?:^|\n)## Gotchas\s*\n([\s\S]*?)(?=\n## |$)/);
    if (!m) return [];
    return m[1].split("\n").filter((l) => l.trim().startsWith("-"));
  }

  function mergeGotchas(target: string, extra: string[]): string {
    const existing = new Set(extractGotchas(target).map((l) => l.toLowerCase()));
    const fresh = extra.filter((l) => !existing.has(l.toLowerCase()));
    if (fresh.length === 0) return target;
    const sectionMatch = target.match(/(?:^|\n)(## Gotchas\s*\n[\s\S]*?)(?=\n## |$)/);
    if (sectionMatch) {
      const block = sectionMatch[1];
      const insert = `${block.trimEnd()}\n${fresh.join("\n")}`;
      return target.replace(block, insert);
    }
    return `${target.trimEnd()}\n\n## Gotchas\n${fresh.join("\n")}\n`;
  }

  const skillDir = resolve(runtime().skillsDir, name);
  ensureDir(skillDir);
  const skillPath = resolve(skillDir, "skill.md");

  let finalContent = content;
  try {
    const existing = readFileSync(skillPath, "utf-8");
    finalContent = mergeGotchas(content, extractGotchas(existing));
  } catch {
    // new skill — no existing file to merge from
  }

  writeFileSync(skillPath, finalContent, "utf-8");

  return { content: [{ type: "text", text: `Skill "${name}" saved at skills/${name}/skill.md` }] };
}

function saveWikiEntry(args: Record<string, unknown>): CallToolResult {
  const rawTopic = safeExt(args, ["topic", "topicName"], "");
  const content: string = safeExt(args, ["content", "text", "body"], "");

  if (!rawTopic) return { content: [{ type: "text", text: "Missing topic." }] };
  if (!content) return { content: [{ type: "text", text: "Missing content." }] };

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const topicId = runtime().topicId;
  const summaryName = wikiSummaryFilename(dateStr, rawTopic, topicId);
  // Human-readable title + stable id for on-disk mirrors. SQLite remains keyed
  // by the canonical topic id below.
  const fileSlug = wikiBriefStorageKey(rawTopic, topicId);
  const name = fileSlug;

  // Save to summaries directory
  ensureDir(runtime().summariesDir);
  const summaryFile = resolve(runtime().summariesDir, summaryName);
  writeFileSync(summaryFile, content, "utf-8");

  // Also update SQLite brief if in topicId mode
  const setTopicBrief = runtime().host.setTopicBrief;
  if (topicId && setTopicBrief) {
    try {
      // Extract a brief from the first paragraph (non-heading)
      const bodyStart = content.indexOf("\n\n");
      const briefParagraph =
        bodyStart > 0
          ? (content.slice(bodyStart).trim().split("\n\n")[0]?.slice(0, 600) ?? "")
          : content.slice(0, 600);
      setTopicBrief(topicId, {
        latestSummaryMd: content,
        summaryDate: dateStr,
        briefMd: briefParagraph,
      });
    } catch {
      // DB update failed — file save succeeded, not critical.
    }
  }

  // Also update topic brief file for backward-compat
  ensureDir(runtime().topicsDir);
  const briefPath = resolve(runtime().topicsDir, `${name}.md`);
  try {
    writeFileSync(briefPath, content, "utf-8");
  } catch {
    /* best effort */
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Saved summary: summaries/${summaryName}` +
          (runtime().topicId ? "\nSQLite brief also updated." : ""),
      },
    ],
  };
}

function indexUpsert(args: Record<string, unknown>): CallToolResult {
  const slug = safeExt(args, ["slug", "id"], "");
  const desc = safeExt(args, ["description", "desc", "text"], "");
  const kind: string = safeExt(args, ["kind", "type"], "article");
  const section = safeExt<string | undefined>(args, ["section", "category"], undefined);
  const date = safeExt<string | undefined>(args, ["date", "created"], undefined);

  if (!slug) return { content: [{ type: "text", text: "Missing slug." }] };

  const today = new Date().toISOString().slice(0, 10);
  const dateStr = date ?? today;

  const indexPath = (() => {
    if (kind === "topic") return resolve(runtime().wikiDir, "topic-index.md");
    if (kind === "skill") return resolve(runtime().wikiDir, "skill-index.md");
    return resolve(runtime().wikiDir, "article-index.md");
  })();

  ensureDir(dirname(indexPath));

  let index: string;
  try {
    index = readFileSync(indexPath, "utf-8");
  } catch {
    index = "";
  }

  const lines = index.split("\n");
  const link = (() => {
    switch (kind) {
      case "summary":
        return `- [[summaries/${slug}]] ${desc} (${dateStr})`;
      case "topic":
        return `- [[topic/${slug}]] ${desc} (${dateStr})`;
      case "skill":
        return `- [[skills/${slug}]] ${desc} (${dateStr})`;
      default:
        return `- [[articles/${slug}]] ${desc} (${dateStr})`;
    }
  })();

  // Find existing entry for this slug and replace, or append
  const slugPattern = `[[${slug}]]`; // loose match on wikilink target
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(slugPattern)) {
      lines[i] = link;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Append to appropriate section
    if (section) {
      let sectionIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith("## ") && lines[i].includes(section)) {
          sectionIdx = i;
          break;
        }
      }
      if (sectionIdx >= 0) {
        // Insert after section heading, before next section
        let insertAt = sectionIdx + 1;
        while (
          insertAt < lines.length &&
          lines[insertAt].trim() !== "" &&
          !lines[insertAt].startsWith("## ")
        ) {
          insertAt++;
        }
        lines.splice(insertAt, 0, link);
      } else {
        lines.push(`\n## ${section}`, link);
      }
    } else {
      lines.push(link);
    }
  }

  writeFileSync(indexPath, lines.join("\n"), "utf-8");

  return { content: [{ type: "text", text: `Index updated: ${link}` }] };
}

// --- MCP Tool definitions -------------------------------------------------

const WIKI_TOOLS: Tool[] = [
  {
    name: "wiki_query",
    description: "Search the wiki knowledge base and return relevant articles.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question or topic to search for" },
        topic: { type: "string", description: "Optional topic name to narrow the search" },
      },
      required: ["question"],
    },
  },
  {
    name: "wiki_topic_brief",
    description: "Get the lightweight topic brief for a specific topic.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic name (e.g. 'dev', 'trading', 'research')" },
      },
      required: ["topic"],
    },
  },
  {
    name: "wiki_last_conversation",
    description: "Read the last N turns from the most recent archived session log for a topic.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic name (e.g. 'dev', 'trading')" },
        turns: {
          type: "number",
          description: "Number of recent turns (max 10), default 5",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "save_wiki_entry",
    description: "Save a session summary directly to wiki/summaries/.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic name of the session" },
        content: { type: "string", description: "Session summary in markdown" },
      },
      required: ["topic", "content"],
    },
  },
  {
    name: "index_upsert",
    description: "Upsert an entry in wiki/article-index.md, topic-index.md, or skill-index.md.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Article/summary slug or topic name" },
        description: { type: "string", description: "Single-line description for the index row" },
        kind: {
          type: "string",
          enum: ["article", "summary", "topic", "skill"],
          description: "Which index to update",
        },
        section: { type: "string", description: "For kind='article': H2 section title" },
        date: { type: "string", description: "Override entry date YYYY-MM-DD (default: today)" },
      },
      required: ["slug", "description", "kind"],
    },
  },
];

const SKILL_TOOLS: Tool[] = [
  {
    name: "skill_query",
    description: "Search this node's local skill library and return matching definitions.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The skill name or description of what you want to do",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "skill_save",
    description: "Create or update a skill on this node.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill folder name in kebab-case" },
        content: {
          type: "string",
          description: "Skill definition in markdown (with frontmatter name+description)",
        },
      },
      required: ["name", "content"],
    },
  },
];

// --- Server ----------------------------------------------------------------

export function createWikiMcpServer(context: WikiMcpContext, host: WikiMcpHost): Server {
  const surface = context.surface ?? "all";
  const wikiDir = resolve(host.wikiRoot);
  const current: WikiRuntime = {
    userId: context.userId,
    topicId: context.topicId,
    surface,
    host,
    wikiDir,
    skillsDir: resolve(wikiDir, "skills"),
    topicsDir: resolve(wikiDir, "topic"),
    summariesDir: resolve(wikiDir, "summaries"),
    articlesDir: resolve(wikiDir, "articles"),
    archiveDir: resolve(wikiDir, "archive"),
  };
  const tools =
    surface === "wiki"
      ? WIKI_TOOLS
      : surface === "skills"
        ? SKILL_TOOLS
        : [...WIKI_TOOLS, ...SKILL_TOOLS];
  for (const directory of [
    current.skillsDir,
    current.topicsDir,
    current.summariesDir,
    current.articlesDir,
    current.archiveDir,
  ]) {
    ensureDir(directory);
  }

  const server = new Server(
    { name: "wiki-server", version: "2.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => ({
      tools,
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    return wikiRuntime.run(current, () => {
      const { name, arguments: args } = request.params;
      const handlers: Record<string, (a: Record<string, unknown>) => CallToolResult> = {
        wiki_query: wikiQuery,
        wiki_topic_brief: wikiTopicBrief,
        wiki_last_conversation: wikiLastConversation,
        skill_query: skillQuery,
        skill_save: skillSave,
        save_wiki_entry: saveWikiEntry,
        index_upsert: indexUpsert,
      };
      const handler = tools.some((tool) => tool.name === name) ? handlers[name] : undefined;
      return handler
        ? handler((args ?? {}) as Record<string, unknown>)
        : { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    });
  });
  return server;
}

// --- Entrypoint ------------------------------------------------------------

async function main() {
  const context = parseArgv();
  let bridge: Partial<WikiMcpHost> = {};
  if (context.topicId) {
    try {
      const mod = await import("#storage/api-topic-brief");
      bridge = { getTopicBrief: mod.getTopicBrief, setTopicBrief: mod.setTopicBrief };
    } catch {
      // DB not available — degrade gracefully (file-only).
    }
  }
  const transport = new StdioServerTransport();
  await createWikiMcpServer(context, { wikiRoot: SHARED_WIKI_DIR, ...bridge }).connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("wiki-server fatal:", err);
    exit(1);
  });
}
