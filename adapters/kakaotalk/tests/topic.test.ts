import { describe, expect, test } from "bun:test";
import { getTopic } from "@negotium/core";
import { ensureKakaoTalkTopic } from "@/topic";

describe("ensureKakaoTalkTopic", () => {
  test("creates exactly one manager-kind topic titled 'kakaotalk' on the kakaotalk surface", () => {
    const topic = ensureKakaoTalkTopic("local-topic-test-1");
    expect(topic.kind).toBe("manager");
    expect(topic.surface).toBe("kakaotalk");
    expect(topic.title).toBe("kakaotalk");
  });

  test("is idempotent: the second call returns the same topic id", () => {
    const first = ensureKakaoTalkTopic("local-topic-test-2");
    const second = ensureKakaoTalkTopic("local-topic-test-2");
    expect(second.id).toBe(first.id);
  });

  test("the created topic is retrievable via getTopic and still a manager room", () => {
    const topic = ensureKakaoTalkTopic("local-topic-test-3");
    const reloaded = getTopic(topic.id);
    expect(reloaded?.kind).toBe("manager");
    expect(reloaded?.title).toBe("kakaotalk");
  });

  test("different users each get their own kakaotalk manager topic", () => {
    const a = ensureKakaoTalkTopic("local-topic-test-4a");
    const b = ensureKakaoTalkTopic("local-topic-test-4b");
    expect(a.id).not.toBe(b.id);
  });
});
