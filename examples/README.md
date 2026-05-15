# examples

Each `*.json` file in this directory is a single JSON-RPC request you can
pipe into the running MCP server over stdio. The MCP transport is
newline-delimited JSON-RPC 2.0, so the simplest way to run one is:

```bash
npm run build
(
  printf '{"jsonrpc":"2.0","id":-1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-cli","version":"0.0.0"}}}\n'
  printf '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n'
  # The example files below are pretty-printed for readability; compact them
  # to a single line because the MCP stdio transport is one JSON-RPC message
  # per line.
  node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync("examples/list_tools.json", "utf8"))))'
  sleep 1
) | node dist/index.js
```

The `protocolVersion` in the `initialize` request should match what your
installed `@modelcontextprotocol/sdk` advertises; `2025-06-18` is the
revision shipped with v1.0.x.

Replace `list_tools.json` with any of the other example files to invoke a
tool:

- [`list_tools.json`](./list_tools.json) — lists the three tools the server
  advertises (no auth or CLI required).
- [`gemini_prompt.json`](./gemini_prompt.json) — sends a free-form prompt
  through the `gemini_prompt` tool.
- [`gemini_prompt_with_context.json`](./gemini_prompt_with_context.json) —
  sends a prompt with a separate `context` block (prepended to the prompt
  inside `<context>` tags) via the `gemini_prompt_with_context` tool.
- [`gemini_prompt_structured.json`](./gemini_prompt_structured.json) — asks
  the model for a JSON value that matches a JSON Schema, exercising the
  `gemini_prompt_structured` tool.

All three tool-call examples require the `gemini` CLI to be installed and
authenticated (see the project [README](../README.md#install-from-npm)).
`list_tools` works offline.
