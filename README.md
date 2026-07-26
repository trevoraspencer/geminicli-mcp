# geminicli-mcp

[![CI](https://github.com/trevoraspencer/geminicli-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/trevoraspencer/geminicli-mcp/actions/workflows/ci.yml)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org/)
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
- **[@google/gemini-cli](https://github.com/google-gemini/gemini-cli) ≥ 0.40.0**
  — this server uses both `--output-format json` and `--skip-trust` for
  reliable non-interactive execution. JSON output first appeared in 0.6.1
  ([upstream PR #8119](https://github.com/google-gemini/gemini-cli/pull/8119));
  `--skip-trust` requires 0.40.0 or newer.

## Install from source

`geminicli-mcp` is not currently published to npm. Until the first release,
install and link a checkout:

```bash
git clone https://github.com/trevoraspencer/geminicli-mcp.git
cd geminicli-mcp
npm ci
npm run build
npm link
```

This exposes the locally built `geminicli-mcp` binary on your `PATH`. Point
your MCP client at it:

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
JSON Schema 2020-12, pre-validate on the caller side. Schema input is limited
to 1 MiB, 10,000 nested schema nodes, and 64 levels of schema nesting.
Potentially super-linear `pattern` shapes are rejected conservatively before
the model is invoked; patterns containing repetition must be start-anchored.
Individual pattern inputs are limited to 65,536 characters, with a
262,144-character aggregate pattern-evaluation budget per response.

## Examples

The [`examples/`](./examples) directory contains runnable JSON-RPC request
files you can pipe into the server over stdio. See
[`examples/README.md`](./examples/README.md) for a one-liner that lists tools
or invokes a tool from the command line.

## Environment

- `GEMINI_CLI_BIN` — override the `gemini` binary path (default: `gemini` on
  `PATH`). On Windows this must point at the CLI's JavaScript entry
  (npm's `gemini.cmd`/`gemini.ps1` shims cannot be spawned without a shell);
  see the Windows note under Troubleshooting.
- `GEMINICLI_MCP_MAX_OUTPUT_BYTES` — cap (per stream) on bytes accumulated
  from the gemini child's stdout/stderr before the server kills it (default:
  33554432 / 32 MiB). The value must be a positive base-10 integer; invalid
  values use the default. Guards against a runaway child OOM-ing the server.
- `GEMINICLI_MCP_DEBUG` — when set to `1`, `true`, or `yes`, emits structured
  JSON diagnostics to stderr (redacted prompt length, invocation flags, exit
  codes, durations, output byte counts, and kill-failure markers). Safe for
  MCP use: diagnostics go to stderr only and never corrupt the stdio protocol
  on stdout. Leave unset in production; enable only for targeted debugging.
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
| `44` | `sandbox_error`    | gemini CLI sandbox setup failed                        |
| `52` | `config_error`     | gemini CLI configuration is invalid                    |
| `53` | `turn_limit`       | gemini's turn / tool-call budget was exhausted         |
|`127` | `error`            | gemini binary not found (set `GEMINI_CLI_BIN`)         |
|`130` | `cancelled`        | the request or gemini CLI was cancelled                |
|other | `unknown`          | gemini reported a code outside the documented set      |

## Security caveats

- **`--approval-mode yolo` and `--skip-trust` are always on.** The server
  hardcodes both flags so it can run non-interactively even when the current
  workspace has no saved Gemini trust decision. Any workspace configuration,
  tool calls, or file edits the gemini CLI accepts are trusted or
  auto-approved. Do not expose this MCP server to MCP clients or workspaces
  you don't trust.
- **No quota controls.** A caller that can reach this server can make
  unlimited gemini API calls at your expense. Gate access at the MCP-client
  layer.
- **Child inherits the server's env.** Don't place secrets in the server's
  env that you don't want the gemini CLI (and its plugins) to see.
- **Prompts are process arguments.** Other users with permission to inspect
  this process may be able to read prompt and context text from the operating
  system's process list.
- **Windows cancellation kills the direct child only.** POSIX hosts signal
  the whole Gemini process group, but Gemini-spawned descendants may outlive
  a cancelled request on Windows.

## Troubleshooting

### `Unknown arguments: output-format` / `skip-trust`

Your `@google/gemini-cli` is older than the supported 0.40.0 minimum.
`--output-format json` was added in 0.6.1
([upstream PR #8119](https://github.com/google-gemini/gemini-cli/pull/8119)),
and this server also requires the newer `--skip-trust` flag. Upgrade:

```bash
npm install -g @google/gemini-cli@latest
gemini --version  # confirm ≥ 0.40.0
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

### Windows: exit 127 even though `gemini` works in your terminal

On Windows, npm installs the `gemini` command as a `gemini.cmd` /
`gemini.ps1` shim. The server spawns the child without a shell (by design —
shell-spawning `.cmd` files is restricted since CVE-2024-27980), so the
default `gemini` binary name cannot be executed and every call returns the
exit-127 "binary not found" result. **On Windows you must point
`GEMINI_CLI_BIN` at the CLI's JavaScript entry**; the server runs
`.js`/`.cjs`/`.mjs` paths with its own Node runtime:

```jsonc
{
  "mcpServers": {
    "gemini": {
      "command": "geminicli-mcp",
      "env": {
        "GEMINI_CLI_BIN": "C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js"
      }
    }
  }
}
```

Find the right path with `npm root -g` — the entry point is
`<npm root -g>\@google\gemini-cli\bundle\gemini.js`.

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
