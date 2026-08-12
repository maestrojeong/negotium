import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTopic } from "@negotium/core";
import { NodeFileStore } from "../src/files";

test("node file store persists runtime output with topic-scoped download access", async () => {
  const root = mkdtempSync(join(tmpdir(), "negotium-node-files-"));
  const source = join(root, "result.md");
  const ownerUserId = `files-owner-${randomUUID()}`;
  const otherUserId = `files-other-${randomUUID()}`;
  const topic = registerTopic({
    title: `files-${randomUUID()}`,
    userId: ownerUserId,
    agent: "codex",
  });
  const store = new NodeFileStore(join(root, "uploads"));
  writeFileSync(source, "runtime output");

  try {
    const attachment = store.store(source, { ownerUserId, topicId: topic.id });
    expect(attachment).not.toBeNull();
    if (!attachment) throw new Error("attachment was not stored");
    expect(attachment).toMatchObject({
      type: "file",
      filename: "result.md",
      mimeType: "text/markdown",
      sizeBytes: 14,
    });
    expect(attachment.url).toContain(`/api/v1/control/files/${attachment.id}`);
    expect(store.hooks.resolveAttachmentByFileId(attachment.id)).toEqual(attachment);
    expect(store.hooks.resolveUploadedFilePathByFileId(attachment.id)).not.toBeNull();
    expect(await store.response(attachment.id, ownerUserId)?.text()).toBe("runtime output");
    expect(store.response(attachment.id, otherUserId)).toBeNull();

    store.deleteForTopic(topic.id);
    expect(store.hooks.resolveAttachmentByFileId(attachment.id)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node file store idempotently stages gateway input under its topic", async () => {
  const root = mkdtempSync(join(tmpdir(), "negotium-node-input-files-"));
  const store = new NodeFileStore(join(root, "uploads"));
  const fileId = randomUUID();
  const access = { ownerUserId: "local", topicId: randomUUID() };
  const file = new File(["<html>ok</html>"], "report.html", { type: "text/html" });

  try {
    const first = await store.storeUploadedFile(fileId, file, access);
    const replay = await store.storeUploadedFile(fileId, file, access);
    expect(first).not.toBeNull();
    expect(replay).toEqual(first);
    expect(store.allows(fileId, access)).toBe(true);
    expect(store.allows(fileId, { ...access, topicId: randomUUID() })).toBe(false);
    expect(
      await store.storeUploadedFile(
        fileId,
        new File(["different"], "report.html", { type: "text/html" }),
        access,
      ),
    ).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
