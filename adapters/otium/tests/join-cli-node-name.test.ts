import { afterEach, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { setGlobalAiName } from "@negotium/core";
import { localNodeNameDefault } from "@/join-cli";

/**
 * Default worker-name priority: `NEGOTIUM_NODE_NAME` (an explicit, persistent
 * operator override) > a customized AI name (`getGlobalAiName()` — someone
 * already renamed this assistant, e.g. "Nova", so reuse that identity rather
 * than inventing another one) > the OS hostname. An AWS EC2 default like
 * `ip-172-31-33-67` is never wrong, but nobody types `--name` every time they
 * re-join, so the hostname alone kept resurfacing it as the node name even
 * after the person had already given the assistant a real name elsewhere.
 */

const originalEnv = process.env.NEGOTIUM_NODE_NAME;

function expectedHostname(): string | undefined {
  return (
    hostname()
      .trim()
      .toLowerCase()
      .replace(/\.local$/, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, 32)
      .replace(/[-._]+$/g, "") || undefined
  );
}

afterEach(() => {
  if (originalEnv === undefined) delete process.env.NEGOTIUM_NODE_NAME;
  else process.env.NEGOTIUM_NODE_NAME = originalEnv;
  // Every test in this file that customizes the AI name must not leak it to
  // whichever test (in this file or another) runs next.
  setGlobalAiName("");
});

describe("localNodeNameDefault", () => {
  test("NEGOTIUM_NODE_NAME wins over the OS hostname", () => {
    process.env.NEGOTIUM_NODE_NAME = "Nova";
    expect(localNodeNameDefault()).toBe("nova");
  });

  test("NEGOTIUM_NODE_NAME wins over a customized AI name too", () => {
    setGlobalAiName("Jarvis");
    process.env.NEGOTIUM_NODE_NAME = "operator-chosen";
    expect(localNodeNameDefault()).toBe("operator-chosen");
  });

  test("a customized AI name is used when NEGOTIUM_NODE_NAME is unset", () => {
    delete process.env.NEGOTIUM_NODE_NAME;
    setGlobalAiName("Nova");
    expect(localNodeNameDefault()).toBe("nova");
  });

  test("the default, never-renamed AI name does not win — it would collide on every node", () => {
    delete process.env.NEGOTIUM_NODE_NAME;
    setGlobalAiName(""); // resets to DEFAULT_AI_NAME ("Otium")
    expect(localNodeNameDefault()).toBe(expectedHostname());
  });

  test("falls back to the OS hostname when nothing is configured", () => {
    delete process.env.NEGOTIUM_NODE_NAME;
    setGlobalAiName("");
    expect(localNodeNameDefault()).toBe(expectedHostname());
  });

  test("falls back to the OS hostname when NEGOTIUM_NODE_NAME is blank", () => {
    process.env.NEGOTIUM_NODE_NAME = "   ";
    setGlobalAiName("");
    expect(localNodeNameDefault()).toBe(expectedHostname());
  });

  test("normalizes an operator-supplied name into the node-name alphabet", () => {
    process.env.NEGOTIUM_NODE_NAME = "  My Cool Mac Mini!! ";
    expect(localNodeNameDefault()).toBe("my-cool-mac-mini");
  });

  test("normalizes a customized AI name into the node-name alphabet too", () => {
    delete process.env.NEGOTIUM_NODE_NAME;
    setGlobalAiName("Nova Prime!!");
    expect(localNodeNameDefault()).toBe("nova-prime");
  });

  test("a configured name that normalizes to nothing falls back the same as unset", () => {
    process.env.NEGOTIUM_NODE_NAME = "!!!";
    setGlobalAiName("");
    expect(localNodeNameDefault()).toBe(expectedHostname());
  });

  test("a customized AI name that normalizes to nothing falls back to the hostname", () => {
    delete process.env.NEGOTIUM_NODE_NAME;
    setGlobalAiName("!!!");
    expect(localNodeNameDefault()).toBe(expectedHostname());
  });
});
