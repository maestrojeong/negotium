import { describe, expect, test } from "bun:test";
import {
  explicitAgentSwitchTargets,
  hasExplicitAgentSwitchRequest,
  isExplicitAgentSwitchTargets,
} from "#agents/explicit-agent-switch";

describe("explicit agent switch derivation", () => {
  test("derives the same answer the phrase test gives, for every agent, over the full prompt", () => {
    const tail = "이제 코덱스로 전환해 주세요";
    const prompt = `${"설명 ".repeat(2_000)}${tail}`;
    expect(Buffer.byteLength(prompt, "utf-8")).toBeGreaterThan(1024);
    expect(hasExplicitAgentSwitchRequest(prompt, "codex")).toBe(true);
    expect(explicitAgentSwitchTargets(prompt)).toEqual(["codex"]);
    expect(explicitAgentSwitchTargets("switch to claude and then use maestro")).toEqual([
      "maestro",
      "claude",
    ]);
    expect(explicitAgentSwitchTargets("claude 모델 설정 코드를 설명해줘")).toEqual([]);
    expect(explicitAgentSwitchTargets(undefined)).toEqual([]);
    expect(explicitAgentSwitchTargets("   ")).toEqual([]);
  });

  test("the derived field is a de-duplicated list of known agents and nothing else", () => {
    expect(isExplicitAgentSwitchTargets([])).toBe(true);
    expect(isExplicitAgentSwitchTargets(["codex", "claude"])).toBe(true);
    expect(isExplicitAgentSwitchTargets(["codex", "codex"])).toBe(false);
    expect(isExplicitAgentSwitchTargets(["gpt"])).toBe(false);
    expect(isExplicitAgentSwitchTargets("codex")).toBe(false);
    expect(isExplicitAgentSwitchTargets([1])).toBe(false);
  });
});
