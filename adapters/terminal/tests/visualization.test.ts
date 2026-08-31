import { describe, expect, test } from "bun:test";
import { isSupportedVisualizationPath, parseVisualizationReference } from "@/visualization";

const PREFIX = "visualize";
const SUFFIX = "";

describe("terminal visualization references", () => {
  test("parses an exact absolute HTML reference", () => {
    expect(
      parseVisualizationReference(`${PREFIX}{"path":"/tmp/report.html","mode":"wide"}${SUFFIX}`),
    ).toEqual({ path: "/tmp/report.html", name: "report.html", mode: "wide" });
  });

  test("parses a reference with an optional title", () => {
    expect(
      parseVisualizationReference(
        `${PREFIX}{"path":"/tmp/report.html","mode":"wide","title":"Quarterly Report"}${SUFFIX}`,
      ),
    ).toEqual({
      path: "/tmp/report.html",
      name: "report.html",
      mode: "wide",
      title: "Quarterly Report",
    });
  });

  test("rejects an empty, oversized, or control-character title", () => {
    expect(
      parseVisualizationReference(`${PREFIX}{"path":"/tmp/report.html","title":""}${SUFFIX}`),
    ).toBeNull();
    expect(
      parseVisualizationReference(
        `${PREFIX}{"path":"/tmp/report.html","title":"${"x".repeat(201)}"}${SUFFIX}`,
      ),
    ).toBeNull();
    expect(
      parseVisualizationReference(
        `${PREFIX}{"path":"/tmp/report.html","title":"bad\u0007title"}${SUFFIX}`,
      ),
    ).toBeNull();
  });

  test("fails closed for malformed, relative, non-HTML, and unsupported references", () => {
    expect(parseVisualizationReference(`${PREFIX}not-json${SUFFIX}`)).toBeNull();
    expect(parseVisualizationReference(`${PREFIX}{"path":"report.html"}${SUFFIX}`)).toBeNull();
    expect(parseVisualizationReference(`${PREFIX}{"path":"/tmp/report.svg"}${SUFFIX}`)).toBeNull();
    expect(
      parseVisualizationReference(`${PREFIX}{"path":"/tmp/report.html","mode":"unknown"}${SUFFIX}`),
    ).toBeNull();
    expect(
      parseVisualizationReference(`${PREFIX}{"path":"/tmp/report.html","open":true}${SUFFIX}`),
    ).toBeNull();
    expect(isSupportedVisualizationPath("/tmp/report\u0000.html")).toBe(false);
  });
});
