import { describe, expect, test } from "bun:test";
import { localDeliveryPrincipal, rosterBoundsSessionTargets } from "#mcp/session-comm/actor-policy";

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
    for (const surface of ["otium", "terminal"]) {
      expect(
        localDeliveryPrincipal({ surface, callerUserId: "local", targetParticipants: dual }),
      ).toBe("local");
      expect(
        localDeliveryPrincipal({ surface, callerUserId: "alice", targetParticipants: dual }),
      ).toBe("alice");
    }
  });

  test("on otium a room of another principal is filed under its own owner", () => {
    expect(
      localDeliveryPrincipal({
        surface: "otium",
        callerUserId: "local",
        targetParticipants: [
          { userId: "bob", role: "member" },
          { userId: "alice", role: "owner" },
        ],
      }),
    ).toBe("alice");
    expect(
      localDeliveryPrincipal({
        surface: "otium",
        callerUserId: "local",
        targetParticipants: [{ userId: "bob", role: "member" }],
      }),
    ).toBe("bob");
  });

  test("refuses when no participant principal exists or off otium", () => {
    expect(
      localDeliveryPrincipal({ surface: "otium", callerUserId: "local", targetParticipants: [] }),
    ).toBeNull();
    expect(
      localDeliveryPrincipal({
        surface: "otium",
        callerUserId: "local",
        targetParticipants: undefined,
      }),
    ).toBeNull();
    expect(
      localDeliveryPrincipal({
        surface: "terminal",
        callerUserId: "local",
        targetParticipants: [{ userId: "alice", role: "owner" }],
      }),
    ).toBeNull();
  });
});
