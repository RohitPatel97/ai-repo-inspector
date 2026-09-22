import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectRepository, MAX_CHANGED_FILES } from "../src/git.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "repo-inspector-git-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runGit(repository: string, ...args: string[]): string {
  return execFileSync("git", [
    "-c", "user.name=Inspector Test", "-c", "user.email=inspector@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false",
    "-c", `core.hooksPath=${join(repository, "no-hooks")}`, ...args,
  ], { cwd: repository, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
}

function repository(): string {
  const directory = temporaryDirectory();
  runGit(directory, "init", "--quiet", "--initial-branch=assessment");
  runGit(directory, "config", "core.autocrlf", "false");
  return directory;
}

function write(repository: string, path: string, content = "content\n"): void {
  writeFileSync(join(repository, path), content);
}

function commit(repository: string, message = "fixture"): string {
  runGit(repository, "add", "--all");
  runGit(repository, "commit", "--quiet", "--allow-empty", "-m", message);
  return runGit(repository, "rev-parse", "HEAD").trim();
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

describe("Git repository inspection", () => {
  it("defaults to HEAD and works on a clean repository with no main branch", () => {
    const repo = repository();
    const head = commit(repo);
    expect(inspectRepository(repo)).toEqual({
      // Native resolution expands Windows 8.3 aliases, matching Git's root spelling.
      repositoryPath: realpathSync.native(repo), baseRef: "HEAD", baseCommit: head, changedFiles: [],
    });
  });

  it("includes unstaged, staged, deleted, renamed and untracked files but excludes ignored files", () => {
    const repo = repository();
    write(repo, ".gitignore", "ignored.txt\n");
    write(repo, "modified.txt", "before\n");
    write(repo, "deleted.txt", "delete this\n");
    write(repo, "old name.txt", "unique rename content\n");
    commit(repo);
    write(repo, "modified.txt", "after\n");
    rmSync(join(repo, "deleted.txt"));
    runGit(repo, "mv", "--", "old name.txt", "new name.txt");
    write(repo, "added.txt", "new staged\n");
    runGit(repo, "add", "--", "added.txt");
    write(repo, "untracked.txt");
    write(repo, "ignored.txt");
    expect(inspectRepository(repo).changedFiles).toEqual([
      { path: "added.txt", status: "added" },
      { path: "deleted.txt", status: "deleted" },
      { path: "modified.txt", status: "modified" },
      { path: "new name.txt", previousPath: "old name.txt", status: "renamed" },
      { path: "untracked.txt", status: "untracked" },
    ]);
  });

  it("reports the net working-tree state instead of double-counting index changes", () => {
    const repo = repository();
    write(repo, "file.txt", "original\n");
    commit(repo);
    write(repo, "file.txt", "staged edit\n");
    runGit(repo, "add", "--", "file.txt");
    write(repo, "file.txt", "original\n");
    expect(inspectRepository(repo).changedFiles).toEqual([]);
    expect(runGit(repo, "diff", "--cached", "--name-only")).toContain("file.txt");
  });

  it("normalizes subdirectory invocation to the canonical repository root", () => {
    const repo = repository();
    const nested = join(repo, "nested");
    mkdirSync(nested);
    commit(repo);
    write(repo, "at-root.txt");
    write(repo, "nested/inside.txt");
    expect(inspectRepository(nested)).toEqual(inspectRepository(repo));
  });

  it("compares an explicit base directly, including committed and local changes", () => {
    const repo = repository();
    write(repo, "file.txt", "baseline\n");
    const base = commit(repo);
    write(repo, "file.txt", "committed edit\n");
    commit(repo);
    write(repo, "local.txt");
    expect(inspectRepository(repo, base)).toMatchObject({
      baseRef: base, baseCommit: base,
      changedFiles: [{ path: "file.txt", status: "modified" }, { path: "local.txt", status: "untracked" }],
    });
  });

  it("uses a divergent branch's commit rather than its merge-base", () => {
    const repo = repository();
    commit(repo, "common ancestor");
    runGit(repo, "checkout", "--quiet", "-b", "other");
    write(repo, "only-other.txt", "other branch\n");
    const base = commit(repo);
    runGit(repo, "checkout", "--quiet", "assessment");
    write(repo, "only-current.txt", "current branch\n");
    commit(repo);
    expect(inspectRepository(repo, "other")).toMatchObject({
      baseCommit: base,
      changedFiles: [{ path: "only-current.txt", status: "added" }, { path: "only-other.txt", status: "deleted" }],
    });
  });

  it("supports an unborn branch without writing an empty-tree object", () => {
    const repo = repository();
    write(repo, "staged.txt");
    runGit(repo, "add", "--", "staged.txt");
    write(repo, "untracked.txt");
    const before = runGit(repo, "count-objects", "-v");
    expect(inspectRepository(repo)).toMatchObject({
      baseRef: "HEAD", baseCommit: null,
      changedFiles: [{ path: "staged.txt", status: "added" }, { path: "untracked.txt", status: "untracked" }],
    });
    expect(runGit(repo, "count-objects", "-v")).toBe(before);
    expect(() => inspectRepository(repo, "HEAD")).toThrow(/Cannot resolve base ref/);
  });

  it("supports a completely empty unborn branch", () => {
    expect(inspectRepository(repository())).toMatchObject({ baseCommit: null, changedFiles: [] });
  });

  it("supports an unborn SHA-256 repository", () => {
    const repo = temporaryDirectory();
    runGit(repo, "init", "--quiet", "--initial-branch=assessment", "--object-format=sha256");
    write(repo, "staged.txt");
    runGit(repo, "add", "--", "staged.txt");
    expect(inspectRepository(repo)).toMatchObject({
      baseCommit: null, changedFiles: [{ path: "staged.txt", status: "added" }],
    });
  });

  it("does not inherit Git variables that redirect inspection to a different repository", () => {
    const intended = repository();
    const other = repository();
    commit(intended);
    write(intended, "intended.txt");
    write(other, "other.txt");
    vi.stubEnv("GIT_DIR", join(other, ".git"));
    vi.stubEnv("GIT_WORK_TREE", other);
    vi.stubEnv("GIT_INDEX_FILE", join(other, ".git", "index"));
    expect(inspectRepository(intended)).toMatchObject({
      repositoryPath: realpathSync.native(intended), changedFiles: [{ path: "intended.txt", status: "untracked" }],
    });
  });

  it("keeps spaces, Unicode and option-looking filenames intact", () => {
    const repo = repository();
    write(repo, "white space.txt");
    write(repo, "résumé.txt");
    write(repo, "--help");
    commit(repo);
    write(repo, "white space.txt", "changed\n");
    write(repo, "résumé.txt", "changed\n");
    write(repo, "--help", "changed\n");
    expect(inspectRepository(repo).changedFiles.map((file) => file.path)).toEqual([
      "--help", "résumé.txt", "white space.txt",
    ]);
  });

  it("preserves a leading U+FEFF in the first untracked filename", () => {
    const repo = repository();
    commit(repo);
    const path = "\uFEFFnotes.txt";
    write(repo, path);
    expect(inspectRepository(repo).changedFiles).toEqual([
      { path, status: "untracked" },
    ]);
  });

  it.skipIf(process.platform === "win32")("keeps tabs and newlines in tracked, renamed and untracked filenames", () => {
    const repo = repository();
    write(repo, "before\tname.txt", "rename me\n");
    write(repo, "modified\nname.txt");
    commit(repo);
    runGit(repo, "mv", "--", "before\tname.txt", "after\nname.txt");
    write(repo, "modified\nname.txt", "changed\n");
    write(repo, "new\t\nname.txt");
    expect(inspectRepository(repo).changedFiles).toEqual([
      { path: "after\nname.txt", previousPath: "before\tname.txt", status: "renamed" },
      { path: "modified\nname.txt", status: "modified" },
      { path: "new\t\nname.txt", status: "untracked" },
    ]);
  });

  it.each(["does-not-exist", "--help", ""])("rejects invalid base ref %j", (base) => {
    const repo = repository();
    commit(repo);
    expect(() => inspectRepository(repo, base)).toThrow(/Cannot resolve base ref/);
  });

  it("rejects missing paths, nonrepositories and bare repositories", () => {
    const directory = temporaryDirectory();
    expect(() => inspectRepository(join(directory, "missing"))).toThrow(/Cannot inspect repository/);
    expect(() => inspectRepository(directory)).toThrow(/Cannot inspect repository/);
    runGit(directory, "init", "--quiet", "--bare");
    expect(() => inspectRepository(directory)).toThrow(/Bare repositories are not supported/);
  });

  it("fails explicitly for an unresolved merge instead of claiming a normal modification", () => {
    const repo = repository();
    write(repo, "conflict.txt", "base\n");
    commit(repo);
    runGit(repo, "checkout", "--quiet", "-b", "other");
    write(repo, "conflict.txt", "other\n");
    commit(repo);
    runGit(repo, "checkout", "--quiet", "assessment");
    write(repo, "conflict.txt", "current\n");
    commit(repo);
    expect(() => runGit(repo, "merge", "--no-edit", "other")).toThrow();
    expect(() => inspectRepository(repo)).toThrow(/unresolved merge conflicts/);
  });

  it("fails explicitly above the changed-file limit without returning a partial review", () => {
    const repo = repository();
    commit(repo);
    for (let i = 0; i <= MAX_CHANGED_FILES; i++) write(repo, `untracked-${i}.txt`);
    expect(() => inspectRepository(repo)).toThrow(/2000 changed-file limit/);
  });

  it("does not invoke external diff, textconv or fsmonitor commands", () => {
    const repo = repository();
    write(repo, ".gitattributes", "*.txt diff=hostile\n");
    write(repo, "file.txt", "before\n");
    commit(repo);
    const markerPath = join(repo, "executed.marker");
    const scriptPath = join(repo, "dangerous.cjs");
    writeFileSync(scriptPath, `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed");`);
    const command = `node "${scriptPath.replaceAll("\\", "/")}"`;
    runGit(repo, "config", "diff.external", command);
    runGit(repo, "config", "diff.hostile.textconv", command);
    runGit(repo, "config", "core.fsmonitor", command);
    write(repo, "file.txt", "after\n");
    expect(inspectRepository(repo).changedFiles).toContainEqual({ path: "file.txt", status: "modified" });
    expect(() => readFileSync(markerPath)).toThrow();
  });
});
