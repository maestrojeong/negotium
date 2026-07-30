export interface SessionTopicRow {
  id: string;
  title: string;
  kind: string | null;
  agent: string | null;
  sessionId: string | null;
  description: string | null;
}

export interface SessionTopicEntry<TAgent extends string = string> {
  sessionId: string;
  messageThreadId: number;
  name: string;
  kind: "agent" | "channel";
  description?: string;
  topicId?: string;
  agent?: TAgent;
}

export interface SessionTarget<TAgent extends string = string> {
  key: string;
  topic: SessionTopicEntry<TAgent>;
}

export type ValidateSessionTargetResult<TAgent extends string = string> =
  | { ok: true; target: SessionTopicEntry<TAgent> }
  | {
      ok: false;
      error: {
        content: Array<{ type: "text"; text: string }>;
        isError: true;
      };
    };

export interface SessionTargetCatalogHost<TAgent extends string = string> {
  readonly listRows: () => SessionTopicRow[];
  readonly currentTopicId?: string;
  readonly currentTopicName?: string;
  readonly isAgent: (value: string | null) => value is TAgent;
}

export interface SessionTargetCatalog<TAgent extends string = string> {
  listTargets(): SessionTarget<TAgent>[];
  getTopics(): Record<string, SessionTopicEntry<TAgent>>;
  validateTarget(to: string): ValidateSessionTargetResult<TAgent>;
}

export function createSessionTargetCatalog<TAgent extends string = string>(
  host: SessionTargetCatalogHost<TAgent>,
): SessionTargetCatalog<TAgent> {
  const { currentTopicId, currentTopicName, isAgent, listRows } = host;

  function listTargets(): SessionTarget<TAgent>[] {
    const eligibleRows = listRows().filter((row) => row.kind !== "manager");
    const titleCounts = new Map<string, number>();
    const qualifiedCounts = new Map<string, number>();
    for (const row of eligibleRows) {
      const normalized = row.title.toLowerCase();
      titleCounts.set(normalized, (titleCounts.get(normalized) ?? 0) + 1);
      const kind = row.kind === "agent" ? "agent" : "channel";
      const qualified = `${kind}:${normalized}`;
      qualifiedCounts.set(qualified, (qualifiedCounts.get(qualified) ?? 0) + 1);
    }

    const rows = eligibleRows.filter((row) =>
      currentTopicId ? row.id !== currentTopicId : row.title !== currentTopicName,
    );
    return rows.map((row) => {
      const agent = isAgent(row.agent) ? row.agent : undefined;
      const kind = row.kind === "agent" ? "agent" : "channel";
      const topic: SessionTopicEntry<TAgent> = {
        sessionId: row.sessionId ?? "",
        messageThreadId: 0,
        name: row.title,
        kind,
        topicId: row.id,
        ...(agent && { agent }),
        ...(row.description && { description: row.description }),
      };
      const collision = (titleCounts.get(row.title.toLowerCase()) ?? 0) > 1;
      const qualified = `${kind}:${row.title}`;
      const sameKindCollision =
        (qualifiedCounts.get(`${kind}:${row.title.toLowerCase()}`) ?? 0) > 1;
      return {
        key: sameKindCollision ? `${qualified}:${row.id}` : collision ? qualified : row.title,
        topic,
      };
    });
  }

  function getTopics(): Record<string, SessionTopicEntry<TAgent>> {
    const result: Record<string, SessionTopicEntry<TAgent>> = {};
    const targets = listTargets();
    const qualifiedCounts = new Map<string, number>();
    for (const { topic } of targets) {
      const qualified = `${topic.kind}:${topic.name.toLowerCase()}`;
      qualifiedCounts.set(qualified, (qualifiedCounts.get(qualified) ?? 0) + 1);
    }
    for (const { key, topic } of targets) {
      const qualified = `${topic.kind}:${topic.name}`;
      if ((qualifiedCounts.get(qualified.toLowerCase()) ?? 0) === 1) {
        result[qualified] = topic;
      }
      result[key] = topic;
    }
    return result;
  }

  function validateTarget(to: string): ValidateSessionTargetResult<TAgent> {
    const topics = getTopics();
    const target = topics[to];
    if (target) return { ok: true, target };

    const available = listTargets()
      .filter(({ topic }) => Boolean(topic.agent))
      .map(({ key }) => key);
    return {
      ok: false,
      error: {
        content: [
          {
            type: "text",
            text: `Error: Session "${to}" not found.\nAvailable: ${available.join(", ") || "none"}`,
          },
        ],
        isError: true,
      },
    };
  }

  return Object.freeze({ listTargets, getTopics, validateTarget });
}
