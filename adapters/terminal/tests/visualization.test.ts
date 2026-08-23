import { describe, expect, test } from "bun:test";
import { isSupportedVisualizationPath, parseVisualizationReference } from "@/visualization";

describe("terminal visualization references", () => {
  test("parses an exact absolute HTML reference", () => {
    expect(
      parseVisualizationReference(
        '\ue200visualize\ue202{"path":"/tmp/report.html","mode":"wide"}\ue201',
      ),
    ).toEqual({ path: "/tmp/report.html", name: "report.html", mode: "wide" });
  });

  test("fails closed for malformed, relative, non-HTML, and unsupported references", () => {
    expect(parseVisualizationReference("\ue200visualize\ue202not-json\ue201")).toBeNull();
    expect(
      parseVisualizationReference('\ue200visualize\ue202{"path":"report.html"}\ue201'),
    ).toBeNull();
    expect(
      parseVisualizationReference('\ue200visualize\ue202{"path":"/tmp/report.svg"}\ue201'),
    ).toBeNull();
    expect(
      parseVisualizationReference(
        '\ue200visualize\ue202{"path":"/tmp/report.html","mode":"unknown"}\ue201',
      ),
    ).toBeNull();
    expect(
      parseVisualizationReference(
        '\ue200visualize\ue202{"path":"/tmp/report.html","open":true}\ue201',
      ),
    ).toBeNull();
    expect(isSupportedVisualizationPath("/tmp/report\u0000.html")).toBe(false);
  });
});
