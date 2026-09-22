#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectReview } from "./core.js";
import { renderReport } from "./report.js";

const HELP = `Usage: inspector review --repo <path> [options]

Inspect a local Git repository. Only explicitly supplied validation commands run.

Options:
  --repo <path>          Repository to inspect (required; paths may contain spaces)
  --base-ref <ref>       Compare tracked changes against this revision (default: HEAD)
  --format <format>      markdown (default) or json
  --validate <command>  Run a trusted shell command in the repository; repeat up to 10 times
  --timeout-ms <ms>     Timeout per command, integer from 1 to 300000
  --output <path|->     Report file, or - for stdout
                        Default: review-report.md / review-report.json in the current directory
  --help                Show this help

Existing output files must be recognizable inspector reports; other files are never overwritten.
Validation commands execute with your account's permissions; they are not sandboxed.
Exit codes: 0 = success, 1 = validation failed, 2 = usage, inspection, or output error.
`;

type ReviewArgs = {
  command: "review";
  repositoryPath: string;
  baseRef?: string;
  format: "markdown" | "json";
  validations: string[];
  timeoutMs?: number;
  output: string;
};

export type Args = { command: "help" } | ReviewArgs;

export function parseArgs(argv: string[]): Args {
  if (argv.length === 1 && argv[0] === "--help") return { command: "help" };
  if (argv.length === 2 && argv[0] === "review" && argv[1] === "--help") {
    return { command: "help" };
  }
  if (argv[0] !== "review") throw new Error("Expected the 'review' command. Use --help for usage.");

  const values = new Map<string, string>();
  const validations: string[] = [];
  const options = new Set(["--repo", "--base-ref", "--format", "--validate", "--timeout-ms", "--output"]);
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    if (!options.has(option)) throw new Error(`Unknown option: ${option}. Use --help for usage.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim() === "") {
      throw new Error(`Missing value for ${option}.`);
    }
    if (option === "--validate") {
      if (validations.length >= 10) throw new Error("At most 10 validation commands are allowed.");
      if (value.length > 8192) throw new Error("Validation commands must be at most 8192 characters.");
      validations.push(value);
    } else {
      if (values.has(option)) throw new Error(`Duplicate option: ${option}.`);
      values.set(option, value);
    }
  }

  const repositoryPath = values.get("--repo");
  if (!repositoryPath) throw new Error("Missing required --repo <path>. Use --help for usage.");
  const format = values.get("--format") ?? "markdown";
  if (format !== "markdown" && format !== "json") throw new Error("--format must be markdown or json.");

  const timeoutValue = values.get("--timeout-ms");
  let timeoutMs: number | undefined;
  if (timeoutValue !== undefined) {
    if (!/^\d+$/.test(timeoutValue) || Number(timeoutValue) < 1 || Number(timeoutValue) > 300000) {
      throw new Error("--timeout-ms must be an integer from 1 to 300000.");
    }
    timeoutMs = Number(timeoutValue);
  }

  return {
    command: "review",
    repositoryPath,
    baseRef: values.get("--base-ref"),
    format,
    validations,
    timeoutMs,
    output: values.get("--output") ?? (format === "json" ? "review-report.json" : "review-report.md"),
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function checkOutputTarget(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Output must be a regular file, not a directory or symbolic link: ${path}`);
  }
  // Bound reads of a user-selected existing file. Generated reports are capped well below this size.
  if (stat.size > 16 * 1024 * 1024) throw new Error(`Refusing to overwrite a file larger than 16 MiB: ${path}`);
  const content = await readFile(path, "utf8");
  if (content.startsWith("<!-- repository-inspector report v1 -->\n")) return;
  try {
    const data: unknown = JSON.parse(content);
    if (typeof data === "object" && data !== null &&
        "schemaVersion" in data && data.schemaVersion === 1 &&
        "repositoryPath" in data && typeof data.repositoryPath === "string" &&
        "changedFiles" in data && Array.isArray(data.changedFiles) &&
        "validationResults" in data && Array.isArray(data.validationResults) &&
        "success" in data && typeof data.success === "boolean") return;
  } catch {
    // Non-JSON files can only qualify through the Markdown marker above.
  }
  throw new Error(`Refusing to overwrite a file that is not an inspector report: ${path}`);
}

async function writeReport(path: string, report: string): Promise<void> {
  const temporaryPath = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(report, "utf8");
    await handle.sync();
    await handle.close();
    // Check again after validation commands, which may have modified the destination.
    await checkOutputTarget(path);
    await rename(temporaryPath, path);
  } finally {
    await handle.close();
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}

function terminalText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

async function writeStdout(value: string): Promise<void> {
  await new Promise<void>((resolveWrite, reject) => {
    // Writable streams emit an error event even when their write callback handles it.
    // Consume that event so a closed downstream pipe produces a concise CLI error.
    const onError = (error: Error) => reject(error);
    process.stdout.once("error", onError);
    process.stdout.write(value, (error) => {
      if (error) {
        reject(error);
      } else {
        process.stdout.removeListener("error", onError);
        resolveWrite();
      }
    });
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.command === "help") {
      await writeStdout(HELP);
      return 0;
    }
    const outputPath = args.output === "-" ? null : resolve(args.output);
    if (outputPath !== null) await checkOutputTarget(outputPath);
    const result = await inspectReview({
      repositoryPath: args.repositoryPath,
      baseRef: args.baseRef,
      validationCommands: args.validations,
      format: args.format,
      timeoutMs: args.timeoutMs,
    });
    const report = renderReport(result, args.format);
    if (outputPath === null) {
      await writeStdout(report);
    } else {
      await writeReport(outputPath, report);
      process.stderr.write(`Review report written to ${terminalText(outputPath)}\n`);
    }
    return result.success ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${terminalText(message)}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
