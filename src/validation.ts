import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import type { ValidationResult } from "./types.js";

export type ValidationOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 1_000;

/** Best effort: a deliberately detached descendant can escape process-tree termination. */
function terminateTree(child: ChildProcess): void {
  if (child.pid === undefined) return;

  if (process.platform === "win32") {
    // Do not run taskkill through a shell or kill the parent before enumerating its tree.
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    const fallback = setTimeout(() => {
      killer.kill();
      child.kill();
    }, TERMINATION_GRACE_MS);
    killer.on("error", () => {
      clearTimeout(fallback);
      child.kill();
    });
    killer.on("close", () => {
      clearTimeout(fallback);
      child.kill();
    });
    return;
  }

  try {
    // Each validation starts a new process group on POSIX.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

/**
 * Executes an explicitly authorized local shell command. This is not a sandbox.
 * stdout and stderr are decoded separately and share raw/decoded byte budgets.
 */
export function runValidation(
  command: string,
  cwd: string,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 300_000);
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
    DEFAULT_MAX_OUTPUT_BYTES,
  );

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const output = Buffer.alloc(maxOutputBytes);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let rawBytes = 0;
    let outputBytes = 0;
    let encodedLimitReached = false;
    let truncated = false;
    let settled = false;
    let stoppedStatus: ValidationResult["status"] | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let terminationDeadline: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;

    function appendText(text: string): void {
      if (encodedLimitReached || text.length === 0) return;
      const encoded = Buffer.from(text, "utf8");
      const remaining = maxOutputBytes - outputBytes;
      let end = Math.min(encoded.length, remaining);
      if (encoded.length > remaining) {
        // Never retain a partial UTF-8 character at the encoded-output boundary.
        while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
        encodedLimitReached = true;
        truncated = true;
      }
      outputBytes += encoded.copy(output, outputBytes, 0, end);
    }

    function finish(exitCode: number | null, signal: string | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(terminationDeadline);
      // A descendant may inherit pipes and keep them open after the shell exits.
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.unref();
      // Flush incomplete characters even on timeout/error. Replacement characters
      // can exceed the encoded budget despite captured raw bytes being below it.
      appendText(stdoutDecoder.end());
      appendText(stderrDecoder.end());
      if (truncated) stoppedStatus ??= "output-limit";
      resolve({
        command,
        status: stoppedStatus ?? (exitCode === 0 ? "passed" : "failed"),
        output: output.subarray(0, outputBytes).toString("utf8"),
        exitCode,
        signal,
        truncated,
        durationMs: Math.round(performance.now() - startedAt),
      });
    }

    function stop(status: ValidationResult["status"]): void {
      if (settled || stoppedStatus !== undefined) return;
      stoppedStatus = status;
      clearTimeout(deadline);
      if (child !== undefined) terminateTree(child);
      // Never wait indefinitely for close: inherited pipes may outlive the shell.
      terminationDeadline = setTimeout(() => {
        child?.kill("SIGKILL");
        finish(child?.exitCode ?? null, child?.signalCode ?? null);
      }, TERMINATION_GRACE_MS);
    }

    function capture(decoder: StringDecoder, chunk: Buffer): void {
      if (settled || stoppedStatus !== undefined) return;
      const remaining = maxOutputBytes - rawBytes;
      const captured = chunk.subarray(0, remaining);
      rawBytes += captured.length;
      appendText(decoder.write(captured));
      if (chunk.length > remaining) {
        truncated = true;
      }
      if (truncated) stop("output-limit");
    }

    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      appendText(error instanceof Error ? error.message : String(error));
      stoppedStatus = "error";
      finish(null, null);
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => capture(stdoutDecoder, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderrDecoder, chunk));
    child.on("error", (error) => {
      if (stoppedStatus === undefined) {
        appendText(error.message);
        stoppedStatus = "error";
      }
      // Negative libuv spawn errors are not process exit codes.
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    deadline = setTimeout(() => stop("timed-out"), timeoutMs);
  });
}

export async function runValidations(
  commands: string[],
  cwd: string,
  options: ValidationOptions = {},
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    results.push(await runValidation(command, cwd, options));
  }
  return results;
}
