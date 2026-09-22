import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { inspectReview, reviewRepository } from "../src/core.js";
import type { ReviewRequest } from "../src/types.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const path = mkdtempSync(join(tmpdir(), "inspector core "));
  directories.push(path);
  execFileSync("git", ["init", "-q", path]);
  mkdirSync(join(path, "nested"));
  writeFileSync(join(path, "new.txt"), "new");
  return path;
}

describe("review orchestration", () => {
  it("renders the same inspection as JSON and Markdown through the public core entry", async () => {
    const repositoryPath = fixture();
    const input = { repositoryPath };
    const data = await inspectReview(input);
    expect(JSON.parse(await reviewRepository({ ...input, format: "json" }))).toEqual(data);
    expect(await reviewRepository(input)).toContain("new.txt (untracked)");
    expect(data.success).toBe(true);
    expect(data.validationResults).toEqual([]);
  });

  it("runs validation from the canonical repository root, records failure, then continues", async () => {
    const path = fixture();
    const result = await inspectReview({ repositoryPath: join(path, "nested"), validationCommands: [
      'node -e "console.log(process.cwd()); process.exit(7)"',
      'node -e "console.log(123)"',
    ] });
    expect(result.success).toBe(false);
    expect(result.validationResults.map((item) => item.status)).toEqual(["failed", "passed"]);
    expect(result.validationResults[0].output.replaceAll("\\", "/")).toContain(result.repositoryPath.replaceAll("\\", "/"));
    expect(result.validationResults[0].exitCode).toBe(7);
  });

  it.each([
    { repositoryPath: "" },
    { repositoryPath: "x", format: "xml" },
    { repositoryPath: "x", timeoutMs: 0 },
    { repositoryPath: "x", timeoutMs: 300001 },
    { repositoryPath: "x", validationCommands: [" "] },
    { repositoryPath: "x", validationCommands: Array(11).fill("echo ok") },
    { repositoryPath: "x", unexpected: "parameter" },
  ])("rejects invalid input before touching Git: %j", async (input) => {
    await expect(inspectReview(input as ReviewRequest)).rejects.toThrow("Invalid review request");
  });
});
