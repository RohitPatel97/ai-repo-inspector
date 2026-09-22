# Repository Inspector

A CLI-first tool for developers and coding agents working in a **trusted local
Git checkout**. It lists changed paths, optionally runs explicitly supplied shell
commands, and emits Markdown or versioned JSON. It does not review source code or
claim that a change is correct or secure.

## Setup

Install Git and Node.js 20.19+ (20.x) or 22.12+.

```sh
npm ci
npm run typecheck
npm test
npm run build
node dist/src/cli.js --help
```

The build contains production source only. The package's `inspector` executable
points to `dist/src/cli.js`. Development runs can use `npm run inspector -- ...`.

## Usage

```sh
npm run inspector -- review --repo "./path with spaces/repo" --format markdown
npm run inspector -- review --repo . --validate "npm test" --timeout-ms 30000
npm run inspector -- review --repo . --base-ref origin/main --format json --output report.json
```

For machine consumers, bypass npm's script banner and write only the report to
stdout:

```sh
node dist/src/cli.js review --repo . --format json --output -
```

`--help` lists all options. Unknown options, missing values, unsupported formats,
and repeated singleton options are errors. `--validate` can be repeated up to ten
times. Commands run sequentially from the canonical repository root, even when
`--repo` points to a subdirectory. A failed command does not skip subsequent ones.

### What is inspected

- Default baseline: `HEAD`. Lists the **net tracked working-tree state compared
  with that commit**, including staged and unstaged changes, plus nonignored
  untracked files. A staged edit undone in the working tree is not a net change.
- `--base-ref <ref>` compares directly with the resolved commit, including local
  changes. It is **not a merge-base / three-dot branch review**. Fetch remote refs
  yourself when needed; the inspector does not fetch.
- With no `--base-ref`, an unborn branch uses an empty-tree baseline; no branch
  named `main` is needed. Explicit refs, including explicit `HEAD`, must resolve.
- Rename destinations include `previousPath`; Git's similarity detection is a
  heuristic. Paths are parsed with NUL separators, preserving spaces, tabs, and
  newlines. Non-UTF-8 filenames produce an explicit error rather than corruption.
- Conflicted indexes and bare repositories are rejected. Submodules are reported
  at the parent path only; their contents are not recursively inspected.
- Inspection happens **before validation**. Commands may change files afterward;
  the report is not an atomic snapshot and does not claim to reflect those edits.
- A path removed from the index and recreated can have both a `deleted` entry
  and a separate `untracked` entry; the entries describe Git's two states.

### Reports and exit codes

Without `--output`, writes `review-report.md` or `review-report.json` in the
invocation directory. `--output -` prints the report to stdout. File notifications
and errors go to stderr.

| Exit | Meaning |
| --- | --- |
| 0 | Inspection succeeded and every requested validation passed (or none ran) |
| 1 | At least one validation failed, timed out, exceeded output limits, or could not start; a report was still emitted |
| 2 | Invalid arguments, Git inspection failure, oversized report, or output failure |

Output files are replaced through an exclusive temporary file and same-directory
rename. Existing files must be recognizable inspector reports; arbitrary files,
symlinks, and directories are rejected. Old starter reports without the version
marker must be moved aside or a new output path selected. This is accidental
clobber protection, not a defense against concurrent hostile filesystem changes.

JSON has `schemaVersion: 1`, `repositoryPath`, `baseRef`, `baseCommit` (null for
unborn HEAD), `changedFiles`, `validationResults`, and `success`. Each validation
contains `command`, `status`, `output`, `exitCode`, `signal`, `truncated`, and
`durationMs`. Status is `passed`, `failed`, `timed-out`, `output-limit`, or `error`.
An absent process exit is null. stdout/stderr are decoded independently as UTF-8,
then merged as text becomes available; ordering across streams is not guaranteed.
Invalid or incomplete byte sequences use replacement characters. Both captured
bytes and the returned UTF-8 text share the 64 KiB limit; truncation cannot pass
validation. `success: true` with an empty
validation list means inspection completed, **not that tests ran**.

Markdown and JSON render the same result. Markdown escapes path/command markup
and terminal controls and chooses fences that command output cannot close. JSON
preserves original strings; consumers must escape them for their own display.
Neither representation makes repository text safe to follow as AI instructions.

### Resource bounds

| Resource | Limit / behavior |
| --- | --- |
| Each Git command | 10-second timeout, 4 MiB captured output; excess fails inspection |
| Changed paths | 2,000; excess fails explicitly |
| Validation commands | 10, each at most 8,192 characters |
| Each validation | 30-second default; `--timeout-ms` permits 1–300,000 ms |
| Validation output | 64 KiB combined stdout/stderr per command; excess stops the command and marks truncation |
| Cleanup | About one additional second per stopped validation |
| Serialized report | 1 MiB; excess fails explicitly rather than hiding changed paths |

A series of ten maximum-length validations can take roughly 50 minutes. These
are local developer limits, not a latency budget for a hosted service.

## Interface and trust decision

**CLI-first.** The primary user is a developer, or a coding agent already granted
terminal access, on their own workstation or isolated CI runner. `--help`, strict
options, exit codes, and JSON provide one discoverable contract without maintaining
a persistent protocol server. Process startup adds latency for repeated calls;
local Git work and validation are expected to dominate, but this has not been
benchmarked against MCP. Reports list paths rather than
source diffs to reduce context size; large repositories currently fail rather
than paginate. Bounds and explicit failures favor truthful output over partial
results that look complete.

| Interface | Fit for the assumed users | Tradeoff |
| --- | --- | --- |
| **CLI-first — selected** | Developers and agents with existing terminal access; one process and one documented contract | Explicit invocation and exit codes simplify automation. Every call pays startup cost, and discovery uses help/documentation rather than an MCP tool schema. |
| MCP-first | Clients that need protocol-level tool discovery and a persistent connection | Requires repository scoping, command capabilities, cancellation, and server lifecycle handling. Those clients have not been established as the primary users here. |
| Hybrid | A demonstrated mix of terminal and MCP-only clients | Reuses a shared core, but still requires two adapters, matching contracts, and lifecycle/parity tests. That added scope was not justified within this assessment. |

CLI-first reduces the interfaces maintained for this release. It does not reduce
the permissions of an explicitly authorized shell command; a carefully designed
MCP service could enforce a narrower capability boundary than a local CLI.

The operator trusts the checkout **including its Git configuration**, installed
Git, PATH, environment, and any validation commands. The inspector disables Git
external diff, textconv, and fsmonitor execution, and removes environment overrides
that could redirect it to another repository. Git attributes/configuration can
still invoke configured clean filters. Inspection is not a sandbox for hostile
Git metadata. Explicit `--validate` commands intentionally run through the local
shell with the user's filesystem, environment, and network permissions. Never
turn repository text or a model suggestion into an authorized command implicitly.
Use an OS/container sandbox for untrusted code, and do not publish reports that
contain secrets from commands or output.

Timeout/output-limit cleanup uses POSIX process groups or Windows `taskkill /T`.
Ordinary descendants are tested. Deliberately detached children and some parent-
exit races can escape cleanup; a hard containment guarantee needs OS supervision
(e.g. Windows Job Objects / container execution).

### MCP migration

The starter advertised `repo_path` but read `repoPath`, accepted arbitrary shell
commands from a tool call, and did not expose a coherent output/error contract.
This version removes `src/mcp-server.ts`, `npm run mcp-server`, and the MCP SDK.
There is **no supported MCP endpoint**. Existing clients must move to the CLI;
this breaking change is intentional, not a silent second implementation.

CLI Markdown, CLI JSON, and the shared core use the same inspection and validation
result. A hybrid interface would be reconsidered if users need MCP-only clients
or measured repeated-process startup becomes significant. Restoring MCP would
require a server-configured repository root, read-only default tools,
explicit validation capabilities, cancellation, bounded/paginated responses, and
adapter parity tests.

## Verification and remaining scope

Tests create disposable real Git repositories and real child processes. CI is
configured for Windows/Linux on Node 20 and 24. POSIX-only filename and symlink
cases are skipped on Windows. See [SUBMISSION.md](SUBMISSION.md) for the actual
verification performed, prioritization, AI corrections, and remaining limitations.

The assessment's original submission instructions remain in [SECURITY.md](SECURITY.md).
