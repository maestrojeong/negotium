import { describe, expect, test } from "bun:test";
import {
  CLI_COMMANDS,
  findCliCommand,
  normalizeCliCommand,
  renderCliHelp,
} from "@/command-catalog";

describe("CLI command catalog", () => {
  test("keeps command names unique and excludes removed shortcuts", () => {
    const names = CLI_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(findCliCommand("adapters")).toBeUndefined();
    expect(findCliCommand("start")).toBeUndefined();
    expect(findCliCommand("chat")).toBeUndefined();
  });

  test("defaults an argument-free invocation to Terminal", () => {
    expect(normalizeCliCommand(undefined)).toBe("terminal");
    expect(normalizeCliCommand("serve")).toBe("serve");
  });

  test("renders grouped help from the catalog", () => {
    const help = renderCliHelp();
    expect(help).toContain("Node:\n");
    expect(help).toContain("Workspace:\n");
    expect(help).toContain("serve [otium]");
    expect(help).toContain("negotium -v | --version");
    expect(help).toContain("With no command, Negotium starts a Terminal client.");
    expect(help).not.toContain("start <terminal|telegram|otium>");
    expect(help).not.toContain("chat [topic]");
  });
});
