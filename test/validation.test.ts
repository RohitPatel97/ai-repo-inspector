import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runValidation, runValidations } from "../src/validation.js";

// Base64 keeps fixture JavaScript independent of POSIX/cmd.exe quoting rules.
function nodeCommand(script: string): string {
  const encoded = Buffer.from(script).toString("base64");
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

describe("validation execution", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "inspector validation "));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("captures stdout and stderr from successful commands", async () => {
    const result = await runValidation(nodeCommand("console.log('stdout'); console.error('stderr');"), cwd);

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.output).toContain("stdout");
    expect(result.output).toContain("stderr");
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("preserves split UTF-8 characters when the other stream interleaves", async () => {
    const result = await runValidation(nodeCommand(
      "process.stdout.write(Buffer.from([0xe2,0x82]));" +
      "setTimeout(()=>{process.stderr.write('ERR');" +
      "setTimeout(()=>process.stdout.write(Buffer.from([0xac])),40)},40);",
    ), cwd);

    expect(result.status).toBe("passed");
    expect(result.output).toContain("€");
    expect(result.output).toContain("ERR");
    expect(result.output).not.toContain("\ufffd");
    expect(Buffer.byteLength(result.output)).toBe(6);
    expect(result.truncated).toBe(false);
  });

  it("records failure as data and continues commands in order", async () => {
    const commands = [
      nodeCommand("console.log('before failure'); console.error('reason'); process.exitCode=7;"),
      nodeCommand("console.log('next command');"),
    ];
    const results = await runValidations(commands, cwd);

    expect(results.map((result) => result.command)).toEqual(commands);
    expect(results.map((result) => result.status)).toEqual(["failed", "passed"]);
    expect(results[0].exitCode).toBe(7);
    expect(results[0].output).toContain("before failure");
    expect(results[0].output).toContain("reason");
    expect(results[1].output).toContain("next command");
  });

  it("times out long-running commands without waiting for their pipes", async () => {
    const result = await runValidation(nodeCommand("setInterval(()=>{},1000);"), cwd, { timeoutMs: 500 });

    expect(result.status).toBe("timed-out");
    expect(result.durationMs).toBeLessThan(4_000);
  }, 6_000);

  it("terminates an ordinary descendant process on timeout", async () => {
    const result = await runValidation(
      nodeCommand(
        "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});" +
        "require('node:fs').writeFileSync('descendant.pid',String(child.pid));setInterval(()=>{},1000);",
      ),
      cwd,
      { timeoutMs: 1_500 },
    );
    const descendantPid = Number(await readFile(join(cwd, "descendant.pid"), "utf8"));

    expect(result.status).toBe("timed-out");
    expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
    try {
      let running = true;
      try {
        process.kill(descendantPid, 0);
        if (process.platform === "linux") {
          // Container PID 1 may not immediately reap an already killed orphan.
          const stat = await readFile(`/proc/${descendantPid}/stat`, "utf8");
          running = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "ENOENT") throw error;
        running = false;
      }
      expect(running).toBe(false);
    } finally {
      // Keep a regression failure from leaving this fixture's process alive.
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already terminated */ }
    }
  }, 7_000);

  it("terminates noisy commands and bounds combined output", async () => {
    const result = await runValidation(
      nodeCommand("setInterval(()=>{process.stdout.write('x'.repeat(4096));process.stderr.write('y'.repeat(4096));},1);"),
      cwd,
      { timeoutMs: 3_000, maxOutputBytes: 1024 },
    );

    expect(result.status).toBe("output-limit");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024);
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeLessThan(4_000);
  }, 6_000);

  it("bounds decoded output even for invalid UTF-8", async () => {
    const result = await runValidation(
      nodeCommand("process.stdout.write(Buffer.alloc(4096,255));"),
      cwd,
      { maxOutputBytes: 1000 },
    );

    expect(result.status).toBe("output-limit");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1000);
  });

  it.each([
    { bytes: [255, 255], maxOutputBytes: 4, expectedOutput: "\ufffd", description: "invalid bytes during capture" },
    { bytes: [0xe2], maxOutputBytes: 2, expectedOutput: "", description: "an incomplete character at stream end" },
  ])("reports output-limit when decoding $description exceeds the byte budget", async ({ bytes, maxOutputBytes, expectedOutput }) => {
    const result = await runValidation(
      nodeCommand(`process.stdout.write(Buffer.from(${JSON.stringify(bytes)}));`),
      cwd,
      { maxOutputBytes },
    );

    expect(bytes.length).toBeLessThan(maxOutputBytes);
    expect(result.status).toBe("output-limit");
    expect(result.truncated).toBe(true);
    expect(result.output).toBe(expectedOutput);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(maxOutputBytes);
  });

  it("returns a spawn error for a missing working directory", async () => {
    const result = await runValidation(nodeCommand("console.log('unreachable');"), join(cwd, "missing"));

    expect(result.status).toBe("error");
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain("ENOENT");
  });

  it("rejects invalid execution limits before spawning a command", () => {
    expect(() => runValidation("echo unexpected", cwd, { timeoutMs: 0 })).toThrow(RangeError);
    expect(() => runValidation("echo unexpected", cwd, { maxOutputBytes: -1 })).toThrow(RangeError);
  });
});
