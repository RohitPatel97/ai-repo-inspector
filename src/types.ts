export type ChangedFile = {
  path: string;
  status: "added" | "modified" | "deleted" | "untracked" | "renamed" | "copied" | "type-changed" | "unmerged";
  previousPath?: string;
};

export type ValidationResult = {
  command: string;
  status: "passed" | "failed" | "timed-out" | "output-limit" | "error";
  output: string;
  exitCode: number | null;
  signal: string | null;
  truncated: boolean;
  durationMs: number;
};

export type ReviewRequest = {
  repositoryPath: string;
  baseRef?: string;
  validationCommands?: string[];
  format?: "markdown" | "json";
  timeoutMs?: number;
};

export type ReviewResult = {
  schemaVersion: 1;
  repositoryPath: string;
  baseRef: string;
  baseCommit: string | null;
  changedFiles: ChangedFile[];
  validationResults: ValidationResult[];
  success: boolean;
};
