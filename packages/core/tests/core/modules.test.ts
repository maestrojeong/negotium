import { describe, expect, test } from "bun:test";
import { runtimeBus } from "#bus";
import type { NegotiumNodeModuleContext } from "#platform/modules";
import { startNegotiumNodeModules } from "#platform/modules";

const context: NegotiumNodeModuleContext = {
  port: 7777,
  stateDir: "/tmp/negotium-test",
  dataDir: "/tmp/negotium-test/data",
  runDir: "/tmp/negotium-test/run",
  workspaceDir: "/tmp/negotium-test/workspace",
  bus: runtimeBus(),
};

describe("optional node modules", () => {
  test("starts in declaration order and stops in reverse order", async () => {
    const calls: string[] = [];
    const modules = ["cron", "peer"].map((name) => ({
      name,
      capabilities: [`module.${name}.v1`],
      start() {
        calls.push(`start:${name}`);
        return {
          stop: () => {
            calls.push(`stop:${name}`);
          },
        };
      },
    }));

    const started = startNegotiumNodeModules(modules, context);
    expect(started.names).toEqual(["cron", "peer"]);
    expect(started.capabilities).toEqual(["module.cron.v1", "module.peer.v1"]);
    await started.stop();
    await started.stop();
    expect(calls).toEqual(["start:cron", "start:peer", "stop:peer", "stop:cron"]);
  });

  test("rejects duplicate module names", () => {
    expect(() =>
      startNegotiumNodeModules(
        [
          { name: "cron", start() {} },
          { name: "cron", start() {} },
        ],
        context,
      ),
    ).toThrow("duplicate negotium module: cron");
  });

  test("rejects ambiguous capability providers", () => {
    expect(() =>
      startNegotiumNodeModules(
        [
          { name: "one", capabilities: ["scheduler.cron.v1"], start() {} },
          { name: "two", capabilities: ["scheduler.cron.v1"], start() {} },
        ],
        context,
      ),
    ).toThrow("duplicate negotium module capability: scheduler.cron.v1");
  });
});
