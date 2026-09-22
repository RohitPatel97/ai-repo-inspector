import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { ChangedFile } from "./types.js";

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
export const MAX_CHANGED_FILES = 2_000;

type GitFailure = Error & {
  code?: string;
  status?: number | null;
  signal?: string | null;
  stderr?: Buffer;
};

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  // A caller's Git process environment must not redirect a review to another
  // repository, object store, or index than the path supplied to this tool.
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

function git(repositoryPath: string, args: string[]): string {
  try {
    const output = execFileSync("git", [
      "--no-pager", "-c", "core.fsmonitor=false", ...args,
    ], {
      cwd: repositoryPath,
      env: gitEnvironment(),
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    // Replacement characters would silently misidentify non-UTF-8 filenames.
    // U+FEFF at the start of a filename is data, not a stream byte-order mark.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output);
  } catch (error) {
    const failure = error as GitFailure;
    if (failure.code === "ETIMEDOUT") {
      throw new Error("Git inspection exceeded the 10 second command timeout.");
    }
    if (failure.code === "ENOBUFS") {
      throw new Error("Git inspection exceeded the 4 MiB output limit; narrow the repository changes.");
    }
    if (failure.code === "ENOENT") {
      throw new Error("Git could not be started. Install Git and ensure it is on PATH.");
    }
    if (error instanceof TypeError) {
      throw new Error("Git returned a filename that is not valid UTF-8; rename it before reviewing.");
    }
    throw error;
  }
}

function withoutFinalNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function failureDetail(error: unknown): string {
  const failure = error as GitFailure;
  return failure.stderr?.toString("utf8").trim().slice(0, 1_000)
    || (error instanceof Error ? error.message : String(error));
}

function nulFields(output: string): string[] {
  if (!output) return [];
  if (!output.endsWith("\0")) throw new Error("Git returned an incomplete filename list.");
  return output.slice(0, -1).split("\0");
}

function parseChangedFiles(output: string): ChangedFile[] {
  const fields = nulFields(output);
  const files: ChangedFile[] = [];
  const statusNames: Record<string, ChangedFile["status"]> = {
    A: "added", M: "modified", D: "deleted", T: "type-changed", U: "unmerged",
  };
  for (let i = 0; i < fields.length;) {
    const code = fields[i++];
    const path = fields[i++];
    if (!path) throw new Error("Git returned a change without a filename.");
    if (/^[RC]\d+$/.test(code)) {
      const destination = fields[i++];
      if (!destination) throw new Error("Git returned an incomplete rename or copy.");
      files.push({ path: destination, previousPath: path, status: code[0] === "R" ? "renamed" : "copied" });
    } else if (Object.hasOwn(statusNames, code)) {
      files.push({ path, status: statusNames[code] });
    } else {
      throw new Error(`Git returned unsupported change status ${JSON.stringify(code)}.`);
    }
    if (files.length > MAX_CHANGED_FILES) throw new Error(`Review exceeds the ${MAX_CHANGED_FILES} changed-file limit.`);
  }
  return files;
}

export type RepositoryInspection = {
  repositoryPath: string;
  baseRef: string;
  baseCommit: string | null;
  changedFiles: ChangedFile[];
};

/** Compare tracked index/worktree state directly to a commit, plus untracked files. */
export function inspectRepository(repositoryPath: string, baseRef?: string): RepositoryInspection {
  let root: string;
  try {
    const requestedPath = realpathSync(repositoryPath);
    if (withoutFinalNewline(git(requestedPath, ["rev-parse", "--is-inside-work-tree"])) !== "true") {
      throw new Error("Bare repositories are not supported; provide a working tree.");
    }
    root = realpathSync(withoutFinalNewline(git(requestedPath, ["rev-parse", "--show-toplevel"])));
  } catch (error) {
    throw new Error(`Cannot inspect repository ${JSON.stringify(repositoryPath)}: ${failureDetail(error)}`);
  }

  const base = baseRef ?? "HEAD";
  let baseCommit: string | null;
  try {
    baseCommit = withoutFinalNewline(git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]));
  } catch (error) {
    if (baseRef !== undefined || (error as GitFailure).status !== 1) {
      throw new Error(`Cannot resolve base ref ${JSON.stringify(base)} to a commit: ${failureDetail(error)}`);
    }
    // A symbolic HEAD whose target does not exist is an unborn branch. Other
    // HEAD failures (for example a corrupt ref) must not look like an empty repo.
    try {
      const headRef = withoutFinalNewline(git(root, ["symbolic-ref", "--quiet", "HEAD"]));
      try {
        git(root, ["show-ref", "--verify", "--quiet", headRef]);
        throw new Error("HEAD exists but does not resolve to a commit.");
      } catch (refError) {
        if ((refError as GitFailure).status !== 1) throw refError;
      }
      baseCommit = null;
    } catch (headError) {
      throw new Error(`Cannot resolve HEAD: ${failureDetail(headError)}`);
    }
  }

  try {
    if (git(root, ["ls-files", "--unmerged", "-z", "--"])) {
      throw new Error("The repository has unresolved merge conflicts. Resolve the index before reviewing.");
    }
    // Git recognizes its empty-tree object even without writing it to disk.
    // Asking Git for the hash also supports SHA-256 repositories.
    const baseline = baseCommit ?? withoutFinalNewline(git(root, ["hash-object", "-t", "tree", "--stdin"]));
    const files = parseChangedFiles(git(root, [
      "diff", "--name-status", "-z", "--no-color", "--no-ext-diff", "--no-textconv",
      "--find-renames=50%", "-l2000", "--ignore-submodules=none", baseline, "--",
    ]));
    const untracked = nulFields(git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"]));
    if (files.length + untracked.length > MAX_CHANGED_FILES) {
      throw new Error(`Review exceeds the ${MAX_CHANGED_FILES} changed-file limit.`);
    }
    files.push(...untracked.map((path) => ({ path, status: "untracked" as const })));
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    return { repositoryPath: root, baseRef: base, baseCommit, changedFiles: files };
  } catch (error) {
    throw new Error(`Git inspection failed: ${failureDetail(error)}`);
  }
}

export function changedFiles(repositoryPath: string, baseRef?: string): ChangedFile[] {
  return inspectRepository(repositoryPath, baseRef).changedFiles;
}
