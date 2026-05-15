# geminicli-mcp

[![CI](https://github.com/trevoraspencer/geminicli-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/trevoraspencer/geminicli-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/geminicli-mcp.svg)](https://www.npmjs.com/package/geminicli-mcp)
[![Node.js Version](https://img.shields.io/node/v/geminicli-mcp.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Stateless stdio MCP server wrapping the headless **Gemini CLI**.

- stdio transport, spawn-per-client
- three tools: `gemini_prompt`, `gemini_prompt_with_context`,
  `gemini_prompt_structured`
- no sessions, no `working_dir`, no timeout enforcement
- runs in the server process's `cwd`
- child env inherits the server's env (so `GEMINI_API_KEY` flows through) and
  pins `NO_COLOR=1`, `TERM=dumb`; prompt is always a single argv element —
  never interpolated into a shell string
- single runtime dependency: `@modelcontextprotocol/sdk`

## Prerequisites

- **Node.js ≥ 20**
- **[@google/gemini-cli](https://github.com/google-gemini/gemini-cli) ≥ 0.6.1**
  — this server invokes the CLI with `--output-format json`, which is only
  recognised by gemini-cli 0.6.1 and newer
  ([upstream PR #8119](https://github.com/google-gemini/gemini-cli/pull/8119)).

## Install from npm

```bash
npm install -g geminicli-mcp
```

This exposes the `geminicli-mcp` binary on your `PATH`. Point your MCP client
at it:

```jsonc
// e.g. ~/.config/<your-client>/mcp.json
{
  "mcpServers": {
    "gemini": {
      "command": "geminicli-mcp"
    }
  }
}
```

You also need the headless Gemini CLI installed and authenticated:

```bash
npm install -g @google/gemini-cli
gemini  # one-time interactive auth
```

## Install from source

```bash
git clone https://github.com/trevoraspencer/geminicli-mcp.git
cd geminicli-mcp
npm install
npm run build
node dist/index.js
```

## Tools

### `gemini_prompt`

| field  | type   | required | notes                 |
|--------|--------|----------|-----------------------|
| prompt | string | yes      | prompt text           |
| model  | string | no       | e.g. `gemini-2.5-pro` |

Returns the CLI's response text.

### `gemini_prompt_with_context`

| field   | type   | required | notes                                      |
|---------|--------|----------|--------------------------------------------|
| prompt  | string | yes      | prompt text                                |
| context | string | yes      | prepended to the prompt inside `<context>` |
| model   | string | no       | e.g. `gemini-2.5-pro`                      |

Returns the CLI's response text.

### `gemini_prompt_structured`

| field   | type   | required | notes                                                       |
|---------|--------|----------|-------------------------------------------------------------|
| prompt  | string | yes      | prompt text                                                 |
| schema  | object | yes      | JSON Schema the response must conform to (see below)        |
| context | string | no       | optional context block prepended inside `<context>`         |
| model   | string | no       | e.g. `gemini-2.5-pro`                                       |

The server appends an explicit "respond with JSON conforming to this schema"
instruction to your prompt, extracts JSON from the model's response (it
tolerates surrounding prose or a ```` ```json ```` fence), and validates the
result against `schema`. On success the tool returns the **canonical JSON
string**. On failure the result is `isError: true` with a diagnostic that
includes both the validation errors and the raw response.

A minimal `schema` looks like:

```json
{
  "type": "object",
  "required": ["title", "tags"],
  "properties": {
    "title": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": false
}
```

The bundled validator supports a useful subset of JSON Schema: `type` (with
all primitive types plus `array` and `object`), `required`, `properties`,
`items`, `additionalProperties`, `enum`, `const`, `minLength`/`maxLength`,
`minItems`/`maxItems`, `minimum`/`maximum`, `pattern`, and the `anyOf` /
`oneOf` / `allOf` combinators. It is deliberately small — if you need full
JSON Schema 2020-12, pre-validate on the caller side.

## Examples

The [`examples/`](./examples) directory contains runnable JSON-RPC request
files you can pipe into the server over stdio. See
[`examples/README.md`](./examples/README.md) for a one-liner that lists tools
or invokes a tool from the command line.

## Environment

- `GEMINI_CLI_BIN` — override the `gemini` binary path (default: `gemini` on
  `PATH`).
- `GEMINICLI_MCP_MAX_OUTPUT_BYTES` — cap (per stream) on bytes accumulated
  from the gemini child's stdout/stderr before the server kills it (default:
  33554432 / 32 MiB). Guards against a runaway child OOM-ing the server.
- `GEMINICLI_MCP_DEBUG` — when set to `1`, `true`, or `yes`, emits structured
  JSON diagnostics to stderr (invocation args, exit codes, durations, stderr
  content, kill-failure markers). Safe for MCP use: diagnostics go to stderr
  only and never corrupt the stdio protocol on stdout. Leave unset in
  production; enable only for targeted debugging.
- Child process env inherits the server's environment, plus forced
  `NO_COLOR=1` / `TERM=dumb`. Anything the server can read — including
  `GEMINI_API_KEY` and friends — the gemini CLI can read.

## Exit codes

The server surfaces the gemini CLI's exit code via the `errorKind` /
`exit=` prefix on error responses (e.g. `[error exit=1] ...`).

| code | `errorKind`        | meaning                                                |
|-----:|--------------------|--------------------------------------------------------|
|  `0` | `ok`               | success                                                |
|  `1` | `error`            | general model error or API failure                     |
| `41` | `auth_required`    | gemini CLI is not authenticated; run `gemini` once     |
| `42` | `input_validation` | bad arguments (or bad schema, for the structured tool) |
| `53` | `turn_limit`       | gemini's turn / tool-call budget was exhausted         |
|`127` | `error`            | gemini binary not found (set `GEMINI_CLI_BIN`)         |
|other | `unknown`          | gemini reported a code outside the documented set      |

## Security caveats

- **`--approval-mode yolo` is always on.** The server hardcodes this flag so
  it can run non-interactively. Any tool calls or file edits the gemini CLI
  performs are auto-approved. Do not expose this MCP server to MCP clients
  you don't trust.
- **No quota controls.** A caller that can reach this server can make
  unlimited gemini API calls at your expense. Gate access at the MCP-client
  layer.
- **Child inherits the server's env.** Don't place secrets in the server's
  env that you don't want the gemini CLI (and its plugins) to see.

## Troubleshooting

### `Unknown arguments: output-format` / `Unknown arguments: outputFormat`

Your `@google/gemini-cli` is older than 0.6.1, which is when
`--output-format json` was added
([upstream PR #8119](https://github.com/google-gemini/gemini-cli/pull/8119)).
Upgrade:

```bash
npm install -g @google/gemini-cli@latest
gemini --version  # confirm ≥ 0.6.1
```

### "Gemini CLI binary not found" (exit 127)

The server could not spawn the `gemini` executable. Either:

- Install the Google headless Gemini CLI
  (`npm install -g @google/gemini-cli`), then verify with
  `which gemini && gemini --version`; or
- Set `GEMINI_CLI_BIN=/absolute/path/to/gemini` in the server's environment.

If you launch the MCP server from a GUI (Claude Desktop, IDE), it may not
inherit your shell `PATH`. Either pass an absolute path via `GEMINI_CLI_BIN`
or configure your MCP client's `env` block, e.g.:

```jsonc
{
  "mcpServers": {
    "gemini": {
      "command": "geminicli-mcp",
      "env": {
        "PATH": "/usr/local/bin:/usr/bin",
        "GEMINI_CLI_BIN": "/usr/local/bin/gemini"
      }
    }
  }
}
```

### "Auth not configured" / authentication errors

The Gemini CLI handles its own auth (Google account, API key, or Vertex AI).
This server does not touch credentials. Run the CLI directly once to
authenticate:

```bash
gemini       # follow the interactive prompts
echo "ping" | gemini -p "Reply with the single word: ping"
```

If you're using an API key, make sure the relevant env vars (e.g.
`GEMINI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`) are present in the MCP
server's `env` block — children inherit the server's environment but the
server's environment is whatever your MCP client gave it.

### "Gemini response did not match schema" (gemini_prompt_structured)

The error text includes both the validation errors and the raw response so
you can see what the model produced. Common fixes:

- Tighten the prompt so it can't ramble (the server already appends a
  JSON-only instruction).
- Make the schema friendlier — e.g. allow `additionalProperties: true` for
  fields you don't need to constrain.
- Pick a stronger model (`model: "gemini-2.5-pro"`).

## Design invariants

These are intentional, not omissions. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full list.

- Stateless: no session IDs, no `--resume`, no `working_dir`.
- Spawn-per-client: one server process per MCP client.
- No timeout enforcement in the server — the client and CLI are
  authoritative.
- No shell interpolation.
- One runtime dependency (`@modelcontextprotocol/sdk`).

## License

[MIT](./LICENSE)
