# Submission

## What did you investigate first, and why?

I began by reviewing the assessment requirements, source modules, package configuration, and public test, then establishing a working baseline through installation, typechecking, and testing. The starter passed those checks, but they did not establish that its Git inspection, validation execution, or advertised interfaces behaved correctly outside the happy path.

I prioritized failures that could produce misleading results or prevent a useful report. The Git comparison assumed a branch named `main` and omitted local work. Filename parsing could corrupt unusual paths and renames. Validation failures interrupted report generation, and output handling could hide stderr. The CLI mishandled paths containing spaces, advertised JSON without implementing it, and referenced an executable path that did not match the build.

I also reproduced the original MCP contract failure in an isolated copy. Initialization and tool discovery succeeded, but a valid request using the advertised `repo_path` field failed because the handler read `repoPath`. That result demonstrated why successful startup and typechecking were insufficient evidence of a reliable interface.

## What did you choose to implement or fix?

I selected a CLI-first implementation and focused on inspection correctness, predictable validation behavior, and consistent reports. Git inspection now resolves the repository root, compares net staged and unstaged changes against HEAD, and includes nonignored untracked files. It supports explicit commit baselines, unborn branches, and SHA-256 repositories. NUL-delimited parsing preserves filenames and rename origins, while conflicts, invalid references, and oversized results produce explicit errors.

Validation commands run sequentially and only when explicitly supplied. Both output streams are retained, and failures, timeouts, and output limits are recorded in the report rather than discarding it. Subsequent commands still run. Output decoding was refined to preserve split UTF-8 characters when stdout and stderr interleave, and decoding-related truncation cannot produce a passing result. A separate regression preserves filenames beginning with U+FEFF.

The CLI now provides strict argument validation, usable help, versioned JSON, Markdown, stdout output, and documented exit codes. Report delivery includes escaped formatting, size limits, controlled file replacement, accidental-overwrite protection, and graceful handling of closed pipes. I also corrected the build path, removed the retired MCP adapter and unused dependencies, and added real-repository and subprocess tests with Windows/Linux CI on Node 20 and 24.

## What did you intentionally not do?

I kept the scope centered on reliable local inspection and explicit validation. This iteration does not add an AI source-code reviewer, hosted service, replacement MCP server, automatic fetching, automatic selection of validation commands, or new Git mutations by the inspector. Recursive submodule inspection, pagination, streaming responses, atomic snapshots, and guaranteed process isolation remain outside the implemented scope.

Three compatibility changes are intentional: local state against HEAD replaces the original default comparison; MCP clients must migrate to the CLI; and unmarked starter reports must be moved aside or written to a new output path. Explicit bases compare directly with the resolved commit. Consumers needing merge-base behavior can calculate that commit and supply it through `--base-ref`. These changes and the migration steps are documented in the README.

## Interface decision

I chose **CLI-first** for developers and AI coding agents that already have terminal access to a trusted checkout on a workstation or isolated CI runner. Git and a supported Node runtime are assumed to be installed. A single executable with help, exit codes, and JSON fits that environment and provides one contract to maintain and verify.

MCP-first would offer stronger protocol-level discovery and persistent connections for MCP clients, but it would also require repository scoping, explicit command capabilities, cancellation, and server lifecycle handling. Hybrid would support both client types while adding adapter-parity and integration obligations. There was insufficient evidence of MCP-only demand to justify that additional scope in this assessment.

The trust boundary includes the checkout and its Git configuration, installed tools, PATH, environment, and explicitly supplied validation commands. Inspection disables external diff, textconv, and fsmonitor behavior and removes environment overrides that could redirect Git to another repository or index. Configured clean filters can still execute. Validation runs through the local shell with the operator's filesystem and network permissions and can modify files. CLI-first does not make execution a sandbox, and report content remains untrusted data for downstream consumers.

Strict parsing and explicit exit codes make failures observable. The CLI uses help and documentation for discovery, while MCP would provide tool schemas. Each CLI invocation incurs process startup overhead; Git and validation are expected to dominate this workflow, but comparative latency has not been benchmarked. Reports contain paths rather than source diffs to control context size. Limits include 2,000 changed paths, 4 MiB and 10 seconds per Git command, ten validations, 64 KiB per validation, and a 1 MiB report. Validation defaults to 30 seconds and can be configured up to five minutes. Limits fail explicitly rather than presenting incomplete output as success.

Markdown and JSON render the same typed result from shared orchestration and request validation, and CLI exit status follows that result. Tests cover the core, source CLI, and built executable. MCP is explicitly retired rather than advertised as a second supported interface. I would reconsider this decision if MCP-only adoption or measured startup costs justified it. A replacement would need configured roots, read-only defaults, controlled validation capabilities, cancellation, bounded responses, and adapter-parity tests.

## How did you use an AI coding agent?

I used **Codex and GitHub Copilot** to support implementation refinement, identify optimization opportunities, and investigate failures and errors. Codex assisted with repository analysis, code drafts, regression tests, documentation, and integration review. The refinements focused on accurate results, bounded resource use, dependable output handling, and reducing unnecessary interface and dependency scope.

GitHub Copilot CLI 1.0.88 provided an independent, read-only static review of the source, tests, README, and submission draft. It could read files but could not run shell commands or make edits. Generated changes and review suggestions were checked against reproductions and test results before being retained. Copilot did not implement a patch or execute the test suite, and no measured performance improvement is claimed.

## Where did you check, correct, or reject an AI suggestion? (required)

The most significant correction involved asynchronous stdout handling. An AI-generated writer checked the write callback but missed the stream's separate `error` event. Closing a real downstream pipe reproduced an unhandled EPIPE, a Node stack trace, and exit code 1 instead of the documented output-error code of 2. The corrected writer handles both mechanisms. Regression tests close subprocess pipes and verify the exit code and diagnostics for help and JSON reports. This addressed the event lifecycle underlying a common piping workflow.

I also rejected a Copilot suggestion after verification. Copilot claimed that calling `FileHandle.close()` twice would reject and cause a successful report write to fail. A direct Node v24.19.0 probe completed both awaited closes successfully, and the existing built CLI wrote its report and exited 0. The suggested patch was not applied because the claimed failure did not reproduce. Copilot reported no other actionable findings in that static review; this does not guarantee that every defect has been found.

## Commands used to verify the result, with outcomes

Local verification used Windows, Node v24.19.0, and Git 2.53.0.windows.3. Because npm was absent from PATH, npm commands were run through `pnpm.cmd dlx npm@11.6.0 <arguments>`. Both `npm install` and `npm ci` passed. `npm run typecheck` and `npm run build` passed, with the executable emitted at `dist/src/cli.js`. The full local `npm test` run passed 71 tests with two Windows-specific skips. `npm audit --json` reported zero vulnerabilities, including development dependencies, and `git diff --check` passed.

The built CLI's `--help` command succeeded. Running `node dist/src/cli.js review --repo . --format json --output -` produced valid versioned JSON and exited 0. Disposable-repository checks verified modified, renamed, and untracked paths in Markdown and JSON. A failing validation retained both output streams, produced a complete report with exit code 1, and allowed the next command to run. Encoding probes verified exact U+FEFF filenames, split UTF-8 output, and explicit failure when decoding exceeded the output limit. The original MCP failure and Copilot's file-handle claim were checked independently as described above.

Cross-platform CI passed installation, typechecking, build, and tests on Windows and Ubuntu with Node 20 and 24. Each Ubuntu job passed all 73 tests. Each Windows job passed 71 tests and skipped two cases involving actual tab/newline filenames and file symlinks; those cases passed on Linux. The suite uses real repositories and subprocesses to exercise conflicts, invalid references, ambient Git overrides, resource limits, output failures, and validation continuation. These results establish the tested behavior, not a guarantee of source-code correctness or security.

## A blocker you hit and how you approached it

The first published CI run failed two Windows tests despite passing local checks. Investigation showed that the tests expected the runner's DOS short path, `RUNNER~1`, while Git returned the equivalent full directory name, `runneradmin`. The failure was in the test's path assumption. I updated the expectations to use `realpathSync.native()` without changing correct production behavior. Focused local tests and the subsequent four-job CI run passed, confirming the correction on the hosted runners.

Setup also exposed missing npm, a TLS certificate failure, and an npm 10 Arborist error. Bundled pnpm, Node's system CA support, and npm 11 resolved those issues without disabling certificate validation. A clean installation and dependency audit verified the resulting dependency state.

## Known limitations and the next three things you would do

Git configuration can still execute clean filters. Process-tree termination is best effort, particularly for detached descendants, and whole-run SIGINT cancellation needs further work. Inspection is not an atomic snapshot; validation can change the checkout after it has been inspected. Filename support is UTF-8 only, submodules are not recursive, and merged stdout/stderr has no global ordering guarantee. Report replacement protects against accidental clobbering rather than hostile filesystem races.

First, I would strengthen whole-run cancellation and process supervision, including Windows Job Objects, using the OS/Node matrix as a regression baseline. Second, I would add snapshot-aware results and broader sparse-checkout, submodule, and concurrent-edit coverage, measuring large repositories before designing pagination. Third, I would measure developer and agent usage and startup costs, introducing constrained MCP only if the evidence supports its additional contract and lifecycle responsibilities.

## Approximate focused-work time

- Start (wall clock): September 22, 2026, 2:36 PM PDT.
- Finish (wall clock): September 22, 2026, 4:20 PM PDT.
