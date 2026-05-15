# Repository Instructions

## Project Overview

This project is a stateless stdio MCP server for the Gemini CLI. It exposes
Gemini as MCP tools and delegates each call to the headless `gemini` command.

## Repository Layout

- `src/index.ts`: MCP server entry point and tool registration.
- `src/invoke.ts`: Gemini CLI process invocation and result handling.
- `src/schema.ts`: Minimal structured-output schema validation.
- `test/*.test.mjs`: Offline `node:test` coverage.
- `examples/`: Example configuration and usage snippets.

## Design Invariants

- The server is stateless. Do not add sessions, resume state, or server-side
  working-directory switching.
- Invoke Gemini with a fresh child process per call and assume one server
  process per MCP client.
- Do not add server-side timeout enforcement; clients and the Gemini CLI are
  responsible for cancellation and time limits.
- Preserve argv-array spawning. Do not concatenate user input into shell
  strings or rely on shell interpolation.
- Child processes inherit the server environment so the Gemini CLI can use the
  same authentication and configuration as the parent process.
- Keep runtime dependencies minimal. `@modelcontextprotocol/sdk` is the only
  runtime dependency.
- Keep tests on the built-in `node:test` runner; do not add a third-party test
  framework.

## Development Commands

```bash
npm install
npm run build
npm test
npm run lint
npm pack --dry-run
```

Use `npm run test:live` only when the Gemini CLI is installed, authenticated,
and live CLI behavior is intentionally being tested.

## Testing Expectations

- Run `npm run build` before `npm test`; tests import compiled files from
  `dist/`.
- Add offline `node:test` coverage for behavior changes.
- Avoid live Gemini tests unless the change specifically depends on real CLI
  behavior.

## Security Cautions

- Never log secrets or environment values that may contain credentials.
- Preserve argv-array spawning for all user-controlled input.
- Do not expose trusted-environment assumptions as user-controlled behavior.
- Keep MCP stdout clean. Diagnostics belong on stderr.

## Contribution Guidance

- Keep changes focused on the requested behavior.
- Update `README.md`, `CHANGELOG.md`, or other public docs when observable
  behavior changes.
- Avoid new runtime dependencies unless the change explicitly justifies them.
