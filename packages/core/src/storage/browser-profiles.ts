import { db } from "#storage/forum-db";

export const DEFAULT_BROWSER_PROFILE = "default";

export interface BrowserProfileRecord {
  name: string;
  createdAt: string | null;
  topics: Array<{ id: string; title: string }>;
  deletable: boolean;
}

export function normalizeBrowserProfileName(name: string): string {
  const value = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(value)) {
    throw new Error("Profile name must be 1-48 lowercase letters, numbers, '-' or '_'.");
  }
  return value;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS browser_profiles (
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, name)
  )
`);

export function getBrowserProfileOwner(topicId: string, fallbackUserId: string): string {
  return (
    db
      .query<{ browser_profile_owner: string | null }, string>(
        "SELECT browser_profile_owner FROM api_topics WHERE id = ?",
      )
      .get(topicId)?.browser_profile_owner ?? fallbackUserId
  );
}

export function isTopicBrowserProfileOwner(topicId: string, userId: string): boolean {
  return getBrowserProfileOwner(topicId, "") === userId;
}

export function getTopicBrowserProfile(topicId: string): string {
  const value = db
    .query<{ browser_profile: string | null }, string>(
      "SELECT browser_profile FROM api_topics WHERE id = ?",
    )
    .get(topicId)?.browser_profile;
  return value || DEFAULT_BROWSER_PROFILE;
}

export function hasBrowserProfileTopic(topicId: string): boolean {
  return Boolean(
    db.query<{ id: string }, string>("SELECT id FROM api_topics WHERE id = ?").get(topicId),
  );
}

export function createBrowserProfile(ownerId: string, rawName: string): string {
  void ownerId;
  const name = normalizeBrowserProfileName(rawName);
  if (name === DEFAULT_BROWSER_PROFILE) return name;
  db.query(
    "INSERT OR IGNORE INTO browser_profiles (owner_id, name, created_at) VALUES (?, ?, ?)",
  ).run("local", name, new Date().toISOString());
  return name;
}

export function assignTopicBrowserProfile(opts: {
  topicId: string;
  actorUserId: string;
  profile: string;
}): { previous: string; profile: string } {
  const actualOwner = getBrowserProfileOwner(opts.topicId, "");
  if (!actualOwner) throw new Error(`Topic "${opts.topicId}" not found or has no owner.`);
  if (actualOwner !== opts.actorUserId) {
    throw new Error(`Only the topic owner can change its browser profile.`);
  }
  const profile = normalizeBrowserProfileName(opts.profile);
  if (profile !== DEFAULT_BROWSER_PROFILE) createBrowserProfile(actualOwner, profile);
  const previous = getTopicBrowserProfile(opts.topicId);
  const result = db
    .query("UPDATE api_topics SET browser_profile = ? WHERE id = ?")
    .run(profile, opts.topicId);
  if (Number(result.changes ?? 0) !== 1) throw new Error(`Topic "${opts.topicId}" not found.`);
  return { previous, profile };
}

export function listBrowserProfiles(ownerId: string): BrowserProfileRecord[] {
  void ownerId;
  const records = db
    .query<{ name: string; created_at: string }, string>(
      "SELECT name, created_at FROM browser_profiles WHERE owner_id = ? ORDER BY name",
    )
    .all("local");
  const topics = db
    .query<{ id: string; title: string; browser_profile: string | null }, []>(
      `SELECT t.id, t.title, t.browser_profile FROM api_topics t
       ORDER BY t.title`,
    )
    .all();

  const byName = new Map<string, BrowserProfileRecord>();
  byName.set(DEFAULT_BROWSER_PROFILE, {
    name: DEFAULT_BROWSER_PROFILE,
    createdAt: null,
    topics: [],
    deletable: false,
  });
  for (const row of records) {
    byName.set(row.name, {
      name: row.name,
      createdAt: row.created_at,
      topics: [],
      deletable: true,
    });
  }
  for (const topic of topics) {
    const name = topic.browser_profile || DEFAULT_BROWSER_PROFILE;
    const record = byName.get(name) ?? {
      name,
      createdAt: null,
      topics: [],
      deletable: name !== DEFAULT_BROWSER_PROFILE,
    };
    record.topics.push({ id: topic.id, title: topic.title });
    record.deletable = false;
    byName.set(name, record);
  }
  return [...byName.values()].sort((a, b) => {
    if (a.name === DEFAULT_BROWSER_PROFILE) return -1;
    if (b.name === DEFAULT_BROWSER_PROFILE) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function assertBrowserProfileDeletable(ownerId: string, rawName: string): string {
  void ownerId;
  const name = normalizeBrowserProfileName(rawName);
  if (name === DEFAULT_BROWSER_PROFILE) throw new Error("The default profile cannot be deleted.");
  const topics = db
    .query<{ id: string; title: string }, string>(
      `SELECT t.id, t.title FROM api_topics t
       WHERE t.browser_profile = ?
       ORDER BY t.title`,
    )
    .all(name);
  if (topics.length > 0) {
    const assigned = topics.map((topic) => `${topic.title} (${topic.id})`).join(", ");
    throw new Error(`Profile "${name}" is assigned to ${topics.length} topic(s): ${assigned}.`);
  }
  return name;
}

export function deleteBrowserProfile(ownerId: string, rawName: string): boolean {
  const name = assertBrowserProfileDeletable(ownerId, rawName);
  const result = db
    .query("DELETE FROM browser_profiles WHERE owner_id = ? AND name = ?")
    .run("local", name);
  return Number(result.changes ?? 0) > 0;
}
