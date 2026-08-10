import { describe, expect, test } from "bun:test";
import {
  createDecisions,
  decisionScopeKey,
  deleteDecisions,
  renderDecisionList,
  type StoredDecision,
  updateDecisions,
  validateDecisionGraph,
} from "#storage/decisions";

const input = (action: string, causedBy?: string[]) => ({
  action,
  reasoning: `Reason for ${action}`,
  agent: "codex" as const,
  timestamp: 1,
  ...(causedBy ? { causedBy } : {}),
});

describe("decision store", () => {
  test("uses the stable topic id before the display title", () => {
    expect(decisionScopeKey({ topicId: "topic-123", session: "Renamed topic" })).toBe("topic-123");
  });

  test("creates a branching directed graph with sequential ids", () => {
    const root = createDecisions([], [input("Choose TypeScript")]).decisions;
    const { decisions } = createDecisions(root, [
      input("Use MCP", ["1"]),
      input("Use flat JSON", ["1"]),
    ]);
    expect(decisions.map(({ id, causedBy }) => ({ id, causedBy }))).toEqual([
      { id: "1", causedBy: undefined },
      { id: "2", causedBy: ["1"] },
      { id: "3", causedBy: ["1"] },
    ]);
  });

  test("rejects missing references and cycles", () => {
    expect(() => createDecisions([], [input("Invalid", ["99"])]).decisions).toThrow(
      "missing decision #99",
    );
    const base = createDecisions([], [input("A"), input("B", ["1"])]).decisions;
    expect(() => updateDecisions(base, [{ id: "1", causedBy: ["2"] }])).toThrow("cycle");
  });

  test("prunes incoming references when a decision is deleted", () => {
    const base: StoredDecision[] = [
      { ...input("A"), id: "1", status: "accepted" },
      { ...input("B", ["1"]), id: "2", status: "executed" },
    ];
    const result = deleteDecisions(base, { ids: ["1"] });
    expect(result).toEqual({
      decisions: [{ ...input("B"), id: "2", status: "executed" }],
      removed: 1,
    });
    expect(() => validateDecisionGraph(result.decisions)).not.toThrow();
  });

  test("renders status, rationale, and upstream ids", () => {
    const text = renderDecisionList([
      { ...input("Use Orchgraph", ["1"]), id: "2", status: "accepted" },
    ]);
    expect(text).toContain("[accepted] #2 Use Orchgraph <- #1");
    expect(text).toContain("Reason for Use Orchgraph");
  });
});
