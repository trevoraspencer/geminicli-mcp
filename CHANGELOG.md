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

### Changed

- Renamed `sanitizedEnv` → `childEnv`. The function never stripped anything;
  the rename makes the contract honest (the gemini child inherits the
  server's full env so `GEMINI_API_KEY` flows through).
- `model` tool argument is now regex-validated
  (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`) to prevent argv flag injection
  via `model: "--help"` etc.
- `resultFromOutcome` now extracts `error.message` from the gemini CLI's
  failure JSON (including the normal `{response: "", error: ...}` shape) so
  users get an actionable error string instead of a generic exit message.
- Child kill on signal termination now resolves with `128 + signo` instead of
  masking the cause as exit code 0.
- Cancellation and output-cap termination signal the full child process group
  on POSIX, preventing Gemini-spawned tools from being orphaned.
- Structured schemas are validated before invocation and bounded to 1 MiB,
  10,000 schema nodes, and 64 levels of nesting.
- Gemini CLI 0.40.0 is now the minimum supported release, and invocations pass
  `--skip-trust` so headless YOLO mode is not silently downgraded in a
  workspace without a saved trust decision.
- Gemini CLI exit codes 44, 52, and 130 are classified as `sandbox_error`,
  `config_error`, and `cancelled`.
- CI actions are immutable-SHA pinned, the compatibility matrix includes Node
  24, dependency install scripts and persisted checkout credentials are
  disabled, and Dependabot monitors npm and GitHub Actions dependencies
  weekly.
- The entry-point check now uses realpath canonicalization so bin symlinks,
  relative launches, and Windows paths work without matching unrelated
  importer filenames.
- `extractJson` no longer emits a spurious "does not match pattern" error
  alongside an "invalid regex in schema.pattern" error.

### Fixed

- Schema validator no longer rejects `null` array items against nullable
  item schemas (`{"items": {"type": ["string", "null"]}}` accepts `[null]`).
- ReDoS pattern heuristic no longer rejects the common optional-suffix idiom
  `(X+)?` (e.g. `^\d+(\.\d+)?$`); only quantifiers that permit repetition
  (`+`, `*`, `{n,}`, `{n,m}` with max > 1) after a quantified group are
  flagged. Pathological patterns like `(a+)+` are still rejected.
- Child stdout/stderr are decoded with a per-stream `StringDecoder`, so
  multibyte UTF-8 sequences split across pipe chunks no longer corrupt the
  output with U+FFFD replacement characters.
- `GEMINICLI_MCP_MAX_OUTPUT_BYTES` now counts bytes (as documented) instead
  of UTF-16 code units, which admitted up to ~4x the configured cap for
  astral-plane content.
- A child that ignores SIGTERM is escalated to SIGKILL after a 2s grace
  period instead of hanging the MCP call forever (output-cap and
  cancellation kills only; no server-side timeout was added).
- A child that traps SIGTERM and exits 0 can no longer turn cancelled or
  truncated output into a successful MCP result.
- Ambiguous repeated regex alternations such as `(a|aa)+`, and repeated groups
  with an earlier inner quantifier, are now rejected by the ReDoS guard.
- Schema validation errors are capped at 100 so a large invalid model response
  cannot exhaust memory by producing an unbounded diagnostic list.
- Invalid partial values such as `64garbage` no longer get accepted as
  `GEMINICLI_MCP_MAX_OUTPUT_BYTES=64`.
- Pretty-printed JSON preceded by a Gemini diagnostic line is recovered
  correctly.
- Structured JSON extraction can recover a later balanced value even when a
  preceding diagnostic contains an unmatched object or array delimiter.
- Prompts beginning with CLI flags such as `--help` and `--version` are bound
  with `--prompt=<value>` so Gemini cannot reinterpret them as options.
- Runtime tool validation now rejects non-object arguments, undeclared fields,
  and argv-incompatible NUL characters instead of accepting or failing them
  later.
- An explicitly supplied empty `context` now produces an empty `<context>`
  block instead of being treated as if the field were absent.
- Process-group SIGKILL escalation remains armed when the direct child exits
  but a stdio-detached descendant survives its initial SIGTERM.
- Structured responses too deep for `JSON.stringify` now return a controlled
  error instead of throwing out of the MCP request handler.
- Nested wrapper groups can no longer hide unsafe regular-expression
  quantifiers or ambiguous alternations from the ReDoS guard.
- Regex safety checks now reject unanchored repetition and adjacent
  overlapping quantified atoms, and pattern evaluation has per-string and
  aggregate work limits to bound backtracking that evades static heuristics.
- Oversized prompt/context argv now returns an `input_validation` result when
  the operating system reports `E2BIG`.
- Importing this package from an unrelated script also named `dist/index.js`
  no longer auto-starts the stdio server.
- Error responses no longer duplicate stderr when stderr was already selected
  as the primary error text.
- Production dependencies now override `@hono/node-server` to a patched 2.x
  release, resolving the transitive `serve-static` path-traversal advisory.
- Published packages now include the source-map files referenced by compiled
  JavaScript, and `prepublishOnly` also runs lint.
- Child exit code 127 now classifies as `error`, matching the README
  exit-code table and the synthesized binary-not-found result.
- `extractJson` no longer swallows non-`json` fence language tags: a
  `js`-fenced response falls through to the balanced-brace scan instead of
  failing `JSON.parse` with the tag inside the payload.
- README: documented that Windows requires `GEMINI_CLI_BIN` to point at the
  gemini CLI's JavaScript entry (npm `.cmd`/`.ps1` shims cannot be spawned
  without a shell).
- README and release history no longer claim that 1.0.0 is available from npm
  or GitHub Releases before those artifacts exist.

### Removed

- `skill.sh` — orphan Hermes-style shell wrapper; not referenced anywhere
  and duplicated logic that drifted from the MCP server's invariants.
- Embedded `[errorKind exit=N]` prefix from raw `GeminiResult.text` values.
  The prefix is now added by `toMcpResult` only, eliminating the double
  prefix that appeared on ENOENT and structured-error paths.

## 1.0.0 - Unreleased

Initial release candidate. This version has not yet been tagged or published
to npm.

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

[Unreleased]: https://github.com/trevoraspencer/geminicli-mcp/commits/main
