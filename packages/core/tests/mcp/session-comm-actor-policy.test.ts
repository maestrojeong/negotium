import { describe, expect, test } from "bun:test";
import {
  crossPrincipalRefusal,
  localDeliveryPrincipal,
  roomStatusPrincipal,
  rosterBoundsSessionTargets,
} from "#mcp/session-comm/actor-policy";

describe("session-comm actor policy (design Q1)", () => {
  test("only otium drops the roster boundary", () => {
    expect(rosterBoundsSessionTargets("otium")).toBe(false);
    expect(rosterBoundsSessionTargets("terminal")).toBe(true);
    expect(rosterBoundsSessionTargets("telegram")).toBe(true);
    expect(rosterBoundsSessionTargets(undefined)).toBe(true);
  });

  test("files under the caller principal whenever it is in the room", () => {
    const dual = [
      { userId: "local", role: "owner" },
      { userId: "alice", role: "owner" },
    ];
    expect(localDeliveryPrincipal({ callerUserId: "local", targetParticipants: dual })).toBe(
      "local",
    );
    expect(localDeliveryPrincipal({ callerUserId: "alice", targetParticipants: dual })).toBe(
      "alice",
    );
  });

  test("never substitutes another principal (no confused deputy)", () => {
    // A room of another principal is refused, never filed under its owner.
    expect(
      localDeliveryPrincipal({
        callerUserId: "local",
        targetParticipants: [
          { userId: "bob", role: "member" },
          { userId: "alice", role: "owner" },
        ],
      }),
    ).toBeNull();
    expect(
      localDeliveryPrincipal({
        callerUserId: "local",
        targetParticipants: [{ userId: "bob", role: "member" }],
      }),
    ).toBeNull();
    expect(localDeliveryPrincipal({ callerUserId: "local", targetParticipants: [] })).toBeNull();
    expect(
      localDeliveryPrincipal({ callerUserId: "local", targetParticipants: undefined }),
    ).toBeNull();
  });

  test("the status principal is read-only and may name the room owner", () => {
    expect(
      roomStatusPrincipal({
        callerUserId: "local",
        targetParticipants: [{ userId: "alice", role: "owner" }],
      }),
    ).toBe("alice");
  });

  test("one refusal wording for tell, ask and abort", () => {
    for (const tool of ["tell_session", "ask_session", "abort_session"] as const) {
      const text = crossPrincipalRefusal(tool, "Room");
      expect(text).toStartWith(`Error: ${tool} to "Room" is not available:`);
      expect(text).toContain("different execution principal");
    }
  });
});
