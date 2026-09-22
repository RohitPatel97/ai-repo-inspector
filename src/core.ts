import { z } from "zod";
import { inspectRepository } from "./git.js";
import { renderReport } from "./report.js";
import type { ReviewRequest, ReviewResult } from "./types.js";
import { runValidations } from "./validation.js";

// Validate at the shared boundary as callers need not be TypeScript clients.
export const reviewRequestSchema = z.object({
  repositoryPath: z.string().min(1).max(32768).refine((value) => !value.includes("\0"), "Path must not contain NUL"),
  baseRef: z.string().min(1).max(1024).refine((value) => !value.includes("\0"), "Ref must not contain NUL").optional(),
  validationCommands: z.array(z.string().min(1).max(8192).refine((value) => value.trim().length > 0 && !value.includes("\0"), "Command must be nonblank and contain no NUL")).max(10).optional(),
  format: z.enum(["markdown", "json"]).optional(),
  timeoutMs: z.number().int().min(1).max(300000).optional(),
}).strict();

export async function inspectReview(request: ReviewRequest): Promise<ReviewResult> {
  const parsed = reviewRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new Error(`Invalid review request: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ")}`);
  }
  const input = parsed.data;
  const inspection = inspectRepository(input.repositoryPath, input.baseRef);
  const validations = await runValidations(
    input.validationCommands ?? [],
    inspection.repositoryPath,
    { timeoutMs: input.timeoutMs },
  );
  return {
    schemaVersion: 1,
    ...inspection,
    validationResults: validations,
    success: validations.every((result) => result.status === "passed"),
  };
}

export async function reviewRepository(request: ReviewRequest): Promise<string> {
  return renderReport(await inspectReview(request), request.format ?? "markdown");
}
