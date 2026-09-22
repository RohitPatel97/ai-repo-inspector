import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";

const projectPath = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(projectPath, "src", "cli.ts");
const tsxPath = join(projectPath, "node_modules", "tsx", "dist", "loader.mjs");
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "inspector-cli-"));
  temporaryPaths.push(cwd);
  const repositoryPath = join(cwd, "repository with spaces");
  mkdirSync(repositoryPath);
  execFileSync("git", ["init", "--quiet", repositoryPath]);
  execFileSync("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"]);
  writeFileSync(join(repositoryPath, "tracked.txt"), "first\n");
  execFileSync("git", ["-C", repositoryPath, "add", "tracked.txt"]);
  execFileSync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "Initial"]);
  writeFileSync(join(repositoryPath, "tracked.txt"), "second\n");
  return { cwd, repositoryPath };
}

function cli(args: string[], cwd: string) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(tsxPath).href, cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
    timeout: 15000,
  });
}

describe("CLI arguments", () => {
  it("preserves spaces and repeated validation order", () => {
    expect(parseArgs(["review", "--repo", "a path with spaces", "--validate", "npm test", "--validate", "npm run lint", "--format", "json", "--timeout-ms", "25"]))
      .toEqual({ command: "review", repositoryPath: "a path with spaces", baseRef: undefined, format: "json", validations: ["npm test", "npm run lint"], timeoutMs: 25, output: "review-report.json" });
  });

  it.each([
    [], ["unknown"], ["review"], ["review", "--repo"],
    ["review", "--repo", "--format", "json"],
    ["review", "--repo", "x", "--format", "yaml"],
    ["review", "--repo", "x", "--unknown", "value"],
    ["review", "--repo", "x", "--repo", "y"],
    ["review", "--repo", "x", "--validate", ""],
    ["review", "--repo", "x", "--timeout-ms", "1.5"],
    ["review", "--repo", "x", "--timeout-ms", "0"],
    ["review", "--repo", "x", "--timeout-ms", "300001"],
    ["review", "--repo", "x", "--output"],
  ].map((args) => ({ args })))("rejects invalid input $args", ({ args }) => {
    expect(() => parseArgs(args)).toThrow();
  });

  it("enforces command count and length limits", () => {
    expect(() => parseArgs(["review", "--repo", "x", ...Array.from({ length: 11 }, () => ["--validate", "echo ok"]).flat()])).toThrow("10");
    expect(() => parseArgs(["review", "--repo", "x", "--validate", "x".repeat(8193)])).toThrow("8192");
  });
});

describe("CLI integration", () => {
  it("emits parseable JSON on stdout for repository paths with spaces", () => {
    const { cwd, repositoryPath } = fixture();
    const result = cli(["review", "--repo", repositoryPath, "--format", "json", "--output", "-"], cwd);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.schemaVersion).toBe(1);
    expect(report.success).toBe(true);
    expect(report.changedFiles).toContainEqual(expect.objectContaining({ path: "tracked.txt", status: "modified" }));
    expect(result.stderr).toBe("");
    expect(readdirSync(cwd)).toEqual(["repository with spaces"]);
  });

  it("writes a failure report and exits 1 when a validation fails", () => {
    const { cwd, repositoryPath } = fixture();
    const result = cli(["review", "--repo", repositoryPath, "--format", "json", "--validate", 'node -e "process.exit(7)"'], cwd);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    const report = JSON.parse(readFileSync(join(cwd, "review-report.json"), "utf8"));
    expect(report.success).toBe(false);
    expect(report.validationResults[0].status).toBe("failed");
  });

  it("writes and replaces its Markdown report atomically", () => {
    const { cwd, repositoryPath } = fixture();
    const args = ["review", "--repo", repositoryPath];
    expect(cli(args, cwd).status).toBe(0);
    writeFileSync(join(repositoryPath, "new.txt"), "new");
    const result = cli(args, cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(cwd, "review-report.md"), "utf8")).toContain("new.txt");
    expect(readdirSync(cwd).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects unrelated existing files before running validation", () => {
    const { cwd, repositoryPath } = fixture();
    const outputPath = join(cwd, "source.ts");
    const original = "export const important = true;\n";
    writeFileSync(outputPath, original);
    const result = cli(["review", "--repo", repositoryPath, "--output", outputPath, "--validate", 'node -e "require(\'fs\').writeFileSync(\'side-effect\', \'ran\')"'], cwd);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("Refusing to overwrite");
    expect(readFileSync(outputPath, "utf8")).toBe(original);
    expect(readdirSync(repositoryPath)).not.toContain("side-effect");
    expect(readdirSync(cwd).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects a directory output without leaving temporary files", () => {
    const { cwd, repositoryPath } = fixture();
    const result = cli(["review", "--repo", repositoryPath, "--output", repositoryPath], cwd);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("regular file");
    expect(readdirSync(cwd).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans up when validation replaces the output with an unrelated file", () => {
    const { cwd, repositoryPath } = fixture();
    const result = cli(["review", "--repo", repositoryPath, "--validate", 'node -e "require(\'fs\').writeFileSync(\'../review-report.md\', \'unrelated file\')"'], cwd);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain("Refusing to overwrite");
    expect(readFileSync(join(cwd, "review-report.md"), "utf8")).toBe("unrelated file");
    expect(readdirSync(cwd).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("escapes terminal control characters in errors and output notices", () => {
    const { cwd, repositoryPath } = fixture();
    const invalid = cli(["review", "--repo", repositoryPath, "--evil\x1b[2J\u202e", "value"], cwd);
    expect(invalid.status, invalid.stderr).toBe(2);
    expect(invalid.stderr).toContain("\\u001b[2J\\u202e");
    expect(invalid.stderr).not.toContain("\x1b");
    const valid = cli(["review", "--repo", repositoryPath, "--output", join(cwd, "report\u202e.md")], cwd);
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stderr).toContain("report\\u202e.md");
    expect(valid.stderr).not.toContain("\u202e");
  });

  it.each(["help", "JSON report"])("handles a closed stdout pipe for %s without a stack trace", async (mode) => {
    const { cwd, repositoryPath } = fixture();
    const args = mode === "help"
      ? ["--help"]
      : ["review", "--repo", repositoryPath, "--format", "json", "--output", "-"];
    const child = spawn(process.execPath, ["--import", pathToFileURL(tsxPath).href, cliPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const status = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    expect(status, stderr).toBe(2);
    expect(stderr).toMatch(/^Error: /);
    expect(stderr).not.toContain("Unhandled 'error' event");
    expect(stderr).not.toContain("at main");
  });

  it.skipIf(process.platform === "win32")("rejects symbolic link output without changing its destination", () => {
    const { cwd, repositoryPath } = fixture();
    const target = join(cwd, "target");
    const link = join(cwd, "report");
    writeFileSync(target, "keep");
    symlinkSync(target, link);
    const result = cli(["review", "--repo", repositoryPath, "--output", link], cwd);
    expect(result.status, result.stderr).toBe(2);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });

  it("reports usage and inspection errors without stack traces or reports", () => {
    const { cwd, repositoryPath } = fixture();
    const invalid = cli(["review", "--repo", repositoryPath, "--format", "bad"], cwd);
    expect(invalid.status, invalid.stderr).toBe(2);
    expect(invalid.stderr).toContain("--format must be");
    const missing = cli(["review", "--repo", join(cwd, "missing")], cwd);
    expect(missing.status, missing.stderr).toBe(2);
    expect(missing.stderr).not.toContain("at main");
    expect(readdirSync(cwd)).toEqual(["repository with spaces"]);
  });

  it("shows useful help without needing a repository", () => {
    const result = cli(["--help"], projectPath);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Exit codes: 0 = success, 1 = validation failed, 2 = usage");
    expect(result.stdout).toContain("not sandboxed");
    expect(result.stderr).toBe("");
  });
});
