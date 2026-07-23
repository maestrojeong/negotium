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

  test("does not suggest after an unsupported copy argument starts", () => {
    expect(commandSuggestions("/copy all")).toEqual([]);
    expect(completeCommand("/cop", 0)).toBe("/copy");
  });

  test("suggests context parity commands", () => {
    expect(commandSuggestions("/comp").map((command) => command.name)).toEqual(["compact"]);
    expect(commandSuggestions("/stat").map((command) => command.name)).toEqual(["status"]);
    expect(commandSuggestions("/mo").map((command) => command.name)).toEqual(["model"]);
    expect(completeCommand("/mo", 0)).toBe("/model");
    expect(commandSuggestions("/ef").map((command) => command.name)).toEqual(["effort"]);
    expect(completeCommand("/ef", 0)).toBe("/effort");
  });

  test("suggests the Vault manager and compact command", () => {
    expect(commandSuggestions("/va").map((command) => command.name)).toEqual(["vault"]);
    expect(completeCommand("/va", 0)).toBe("/vault ");
  });

  test("suggests topic privacy commands", () => {
    expect(commandSuggestions("/pub").map((command) => command.name)).toEqual(["public"]);
    expect(commandSuggestions("/pri").map((command) => command.name)).toEqual(["private"]);
    expect(completeCommand("/pub", 0)).toBe("/public");
    expect(completeCommand("/pri", 0)).toBe("/private");
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
