# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `auth_required` `errorKind` for gemini CLI exit code 41 (missing or invalid
  auth).
- `GEMINICLI_MCP_MAX_OUTPUT_BYTES` environment variable — per-stream cap on
  child stdout/stderr (default 32 MiB). The child is SIGTERM'd on overflow.
- `AbortSignal` plumbing: the MCP request's per-call signal is threaded
  through to the gemini child, so a cancelled MCP request actually kills the
  child instead of leaking it.
- Exported pure handlers `handleListTools` / `handleCallTool` for in-process
  testing.
- `examples/gemini_prompt_with_context.json` — previously missing example
  for the context tool.
- `SECURITY.md`.
- README sections: **Prerequisites**, **Exit codes**, **Security caveats**;
  troubleshooting bullet for `Unknown arguments: output-format` (gemini-cli
  < 0.6.1).
- CI now runs on macOS in addition to Ubuntu, and verifies `npm pack
  --dry-run` to catch packaging regressions.

### Changed

- Renamed `sanitizedEnv` → `childEnv`. The function never stripped anything;
  the rename makes the contract honest (the gemini child inherits the
  server's full env so `GEMINI_API_KEY` flows through).
- `model` tool argument is now regex-validated
  (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`) to prevent argv flag injection
  via `model: "--help"` etc.
- `resultFromOutcome` now extracts `error.message` from the gemini CLI's
  failure JSON so users get an actionable error string instead of a raw blob.
- Child kill on signal termination now resolves with `128 + signo` instead of
  masking the cause as exit code 0.
- `invokedDirectly` entry-point check is more robust (uses
  `fileURLToPath` + `path.resolve` so symlinks and Windows paths work).
- `extractJson` no longer emits a spurious "does not match pattern" error
  alongside an "invalid regex in schema.pattern" error.

### Removed

- `skill.sh` — orphan Hermes-style shell wrapper; not referenced anywhere
  and duplicated logic that drifted from the MCP server's invariants.
- Embedded `[errorKind exit=N]` prefix from raw `GeminiResult.text` values.
  The prefix is now added by `toMcpResult` only, eliminating the double
  prefix that appeared on ENOENT and structured-error paths.

## [1.0.0] - 2026-05-12

First public release on npm.

### Added

- **`gemini_prompt`** — stateless single-shot tool that invokes the headless
  Gemini CLI with a prompt and returns the model's response text.
- **`gemini_prompt_with_context`** — same as `gemini_prompt` but accepts a
  separate `context` string that is prepended to the prompt inside a
  `<context>` tag.
- **`gemini_prompt_structured`** — invokes the Gemini CLI, parses the
  response as JSON, and validates it against a caller-provided JSON Schema.
  Returns the validated JSON value or an `isError` result with a clear
  diagnostic when the response is not valid JSON or does not match the schema.
  Uses a tiny hand-rolled JSON-Schema-subset validator (no runtime dependency
  on `ajv`).
- Sanitized child environment: `NO_COLOR=1` and `TERM=dumb` are always set.
- Exit-code taxonomy (`ok` / `error` / `input_validation` / `turn_limit` /
  `unknown`) surfaced via the `errorKind` field and the `isError` flag.
- Friendly `ENOENT` handling: if the `gemini` binary is missing, the tool
  result includes installation guidance and the `GEMINI_CLI_BIN` override.

### Design

- **Stateless.** No session IDs, no `--resume`, no `working_dir` parameter.
  The child process runs in the MCP server's `process.cwd()`.
- **Spawn-per-client.** One server process per MCP client; no pooling.
- **No shell interpolation.** The prompt is always passed as a single argv
  element, never concatenated into a shell string.
- **No timeout enforcement** in the server — the client and CLI are
  authoritative on cancellation.
- Single runtime dependency: `@modelcontextprotocol/sdk`.

[Unreleased]: https://github.com/trevoraspencer/geminicli-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/trevoraspencer/geminicli-mcp/releases/tag/v1.0.0
