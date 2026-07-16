import { describe, expect, test } from "bun:test";
import { commandSuggestions, completeCommand } from "@/commands";

describe("terminal slash command completion", () => {
  test("filters commands by prefix", () => {
    expect(commandSuggestions("/to").map((command) => command.name)).toEqual(["topics"]);
  });

  test("adds an argument space only for commands that accept arguments", () => {
    expect(completeCommand("/ne", 0)).toBe("/new");
    expect(completeCommand("/to", 0)).toBe("/topics");
    expect(completeCommand("/de", 0)).toBe("/del");
    expect(completeCommand("/he", 0)).toBe("/help");
  });

  test("does not suggest after argument entry starts", () => {
    expect(commandSuggestions("/copy all")).toEqual([]);
  });

  test("suggests context parity commands", () => {
    expect(commandSuggestions("/comp").map((command) => command.name)).toEqual(["compact"]);
    expect(commandSuggestions("/stat").map((command) => command.name)).toEqual(["status"]);
    expect(commandSuggestions("/mo").map((command) => command.name)).toEqual(["model"]);
    expect(completeCommand("/mo", 0)).toBe("/model");
  });

  test("uses only the short delete command", () => {
    expect(commandSuggestions("/de").map((command) => command.name)).toEqual(["del"]);
    expect(commandSuggestions("/de")[0]?.usage).toBe("/del");
    expect(commandSuggestions("/delete")).toEqual([]);
  });

  test("suggests fork and spawn commands", () => {
    expect(commandSuggestions("/fo").map((command) => command.name)).toEqual(["fork"]);
    expect(commandSuggestions("/sp").map((command) => command.name)).toEqual(["spawn"]);
    expect(completeCommand("/fo", 0)).toBe("/fork ");
    expect(completeCommand("/sp", 0)).toBe("/spawn ");
  });
});
