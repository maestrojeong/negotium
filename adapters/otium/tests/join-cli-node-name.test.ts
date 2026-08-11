import { afterEach, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { localNodeNameDefault } from "@/join-cli";

/**
 * `NEGOTIUM_NODE_NAME` lets an operator give a host a persistent,
 * human-chosen identity that survives every re-enrollment, instead of
 * depending on whatever the OS calls the machine (an AWS EC2 default like
 * `ip-172-31-33-67` is never wrong, but nobody types `--name` every time they
 * re-join, so the OS hostname alone kept resurfacing it as the node name).
 */

const original = process.env.NEGOTIUM_NODE_NAME;

afterEach(() => {
  if (original === undefined) delete process.env.NEGOTIUM_NODE_NAME;
  else process.env.NEGOTIUM_NODE_NAME = original;
});

describe("localNodeNameDefault", () => {
  test("NEGOTIUM_NODE_NAME wins over the OS hostname", () => {
    process.env.NEGOTIUM_NODE_NAME = "Nova";
    expect(localNodeNameDefault()).toBe("nova");
  });

  test("falls back to the OS hostname when unset", () => {
    delete process.env.NEGOTIUM_NODE_NAME;
    const expected = hostname()
      .trim()
      .toLowerCase()
      .replace(/\.local$/, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 32)
      .replace(/[-._]+$/g, "");
    expect(localNodeNameDefault()).toBe(expected || undefined);
  });

  test("falls back to the OS hostname when NEGOTIUM_NODE_NAME is blank", () => {
    process.env.NEGOTIUM_NODE_NAME = "   ";
    const expected = hostname()
      .trim()
      .toLowerCase()
      .replace(/\.local$/, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 32)
      .replace(/[-._]+$/g, "");
    expect(localNodeNameDefault()).toBe(expected || undefined);
  });

  test("normalizes an operator-supplied name into the node-name alphabet", () => {
    process.env.NEGOTIUM_NODE_NAME = "  My Cool Mac Mini!! ";
    expect(localNodeNameDefault()).toBe("my-cool-mac-mini");
  });

  test("a configured name that normalizes to nothing falls back to the hostname", () => {
    process.env.NEGOTIUM_NODE_NAME = "!!!";
    const expected = hostname()
      .trim()
      .toLowerCase()
      .replace(/\.local$/, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 32)
      .replace(/[-._]+$/g, "");
    expect(localNodeNameDefault()).toBe(expected || undefined);
  });
});
