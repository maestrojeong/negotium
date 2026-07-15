import { describe, expect, test } from "bun:test";
import { commandSuggestions, completeCommand } from "@/commands";

describe("terminal slash command completion", () => {
  test("filters commands by prefix", () => {
    expect(commandSuggestions("/to").map((command) => command.name)).toEqual(["topic", "topics"]);
  });

  test("adds an argument space only for commands that accept arguments", () => {
    expect(completeCommand("/ne", 0)).toBe("/new ");
    expect(completeCommand("/he", 0)).toBe("/help");
  });

  test("does not suggest after argument entry starts", () => {
    expect(commandSuggestions("/topic work")).toEqual([]);
  });

  test("suggests context parity commands", () => {
    expect(commandSuggestions("/comp").map((command) => command.name)).toEqual(["compact"]);
    expect(commandSuggestions("/stat").map((command) => command.name)).toEqual(["status"]);
  });
});
