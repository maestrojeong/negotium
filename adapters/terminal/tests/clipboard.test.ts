import { describe, expect, test } from "bun:test";
import { MAX_CLIPBOARD_BYTES, osc52Sequence } from "@/clipboard";

describe("terminal clipboard", () => {
  test("encodes text using OSC52", () => {
    const sequence = osc52Sequence("한글 copy");
    expect(sequence.startsWith("\u001b]52;c;")).toBe(true);
    expect(sequence.endsWith("\u0007")).toBe(true);
    const encoded = sequence.slice("\u001b]52;c;".length, -1);
    expect(Buffer.from(encoded, "base64").toString()).toBe("한글 copy");
  });

  test("caps terminal clipboard payloads", () => {
    const sequence = osc52Sequence("가".repeat(MAX_CLIPBOARD_BYTES));
    const encoded = sequence.slice("\u001b]52;c;".length, -1);
    expect(Buffer.byteLength(Buffer.from(encoded, "base64"))).toBeLessThanOrEqual(
      MAX_CLIPBOARD_BYTES,
    );
  });
});
