import { describe, expect, it } from "vitest";
import { markdownReport, renderReport } from "../src/report.js";
import type { ReviewResult, ValidationResult } from "../src/types.js";

const validation: ValidationResult = { command: "npm test", status: "passed", output: "ok", exitCode: 0, signal: null, truncated: false, durationMs: 10 };
const sample: ReviewResult = {
  schemaVersion: 1, repositoryPath: "/work/sample", baseRef: "HEAD", baseCommit: "abc123",
  changedFiles: [{ path: "src/index.ts", status: "modified" }],
  validationResults: [validation], success: true,
};

describe("markdownReport", () => {
  it("lists changed files and validation output", () => {
    const report = markdownReport(sample);

    expect(report).toContain("src/index.ts (modified)");
    expect(report).toContain("npm test");
    expect(report).toContain("ok");
  });

  it("shows failure metadata, empty output, rename origins and truncation", () => {
    const report = markdownReport({ ...sample, success: false,
      changedFiles: [{ path: "new.ts", previousPath: "old.ts", status: "renamed" }],
      validationResults: [{ ...validation, status: "output-limit", output: "", exitCode: null, truncated: true }],
    });
    expect(report).toContain("Validation: failed");
    expect(report).toContain("new.ts (renamed; from old.ts)");
    expect(report).toContain("Status: output-limit; exit code: none");
    expect(report).toContain("truncated: yes");
    expect(report).toContain("(no output)");
  });

  it("does not claim unchecked changes passed validation", () => {
    const report = markdownReport({ ...sample, changedFiles: [], validationResults: [] });
    expect(report).toContain("Validation: not run");
    expect(report).toContain("No changes found");
    expect(report).toContain("No validation commands requested");
    expect(report).not.toContain("Validation: passed");
  });

  it("escapes hostile filenames and prevents output from closing its code block", () => {
    const report = markdownReport({ ...sample,
      changedFiles: [{ path: "<script>\n# forged [link](url)\u001b[2J", status: "untracked" }],
      validationResults: [{ ...validation, output: "```\n# forged heading\n````\n\u001b[2J" }],
    });
    expect(report).toContain("&lt;script&gt;");
    expect(report).toContain("\\# forged \\[link\\]");
    expect(report).not.toContain("\u001b");
    expect(report).not.toContain("<script>");
    expect(report).toContain("`````text\n```\n# forged heading\n````\n\\u001b[2J\n`````");
  });

  it("JSON has a versioned contract and preserves filenames without Markdown escaping", () => {
    const input = { ...sample, changedFiles: [{ path: "name\twith\ncontrols", status: "untracked" as const }] };
    expect(JSON.parse(renderReport(input, "json"))).toEqual(input);
    expect(renderReport(input, "markdown")).not.toContain("name\twith\ncontrols");
  });

  it("rejects oversized reports instead of silently omitting changes", () => {
    const input = { ...sample, validationResults: [{ ...validation, output: "x".repeat(1024 * 1024) }] };
    expect(() => renderReport(input, "json")).toThrow("1 MiB");
    expect(() => renderReport(input, "markdown")).toThrow("1 MiB");
  });
});
