# Security policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Report privately via one of:

- GitHub's [private vulnerability reporting](https://github.com/trevoraspencer/geminicli-mcp/security/advisories/new) for this repo.
- Email: `trevoraspencer@gmail.com` with `[geminicli-mcp security]` in the subject.

You should expect an acknowledgement within a few days. If the issue is
valid we'll work with you on a fix and a coordinated disclosure timeline.

## Threat model

`geminicli-mcp` is a stdio MCP server. The threat model assumes the MCP
**client** is trusted (it can launch the server process, set its env, and
call its tools). Anything that can reach the server's stdio can do anything
this server can do. Concretely:

- **`--approval-mode yolo` and `--skip-trust` are always on.** The server
  hardcodes both flags so it can run non-interactively without a saved folder
  trust decision. Workspace configuration is trusted for the invocation, and
  any tool calls or file edits the gemini CLI performs are auto-approved.
  **Do not expose this MCP server to MCP clients or workspaces you do not
  trust.**
- **Child env inherits the server env.** Environment variables such as
  `GEMINI_API_KEY` and `GOOGLE_APPLICATION_CREDENTIALS` are visible to the
  gemini child and to any tool gemini decides to invoke. The child also has
  the server user's filesystem permissions, so accessible shell history and
  dotfile secrets may be read through tools. Treat both as part of the trust
  boundary.
- **No quota or rate limiting.** A caller that can reach the server can
  make unlimited gemini API calls at your expense. Gate access at the
  MCP-client layer.
- **No prompt sanitisation.** Prompts are passed verbatim to the gemini CLI
  via a bound argv element. There is no shell interpolation, but other users
  allowed to inspect this process may be able to read prompt and context
  text from the operating system's process list.
- **No timeout enforcement** in the server. The client is authoritative on
  cancellation; the server honours the MCP request's `AbortSignal` and a
  per-stream output cap (`GEMINICLI_MCP_MAX_OUTPUT_BYTES`, default 32 MiB)
  to prevent a runaway child from OOM-ing the host, but there is no
  wall-clock timeout. On POSIX, cancellation signals the entire Gemini
  process group; on Windows it kills only the direct child, so descendants
  may outlive the request.

If your deployment puts this server behind anything that smells like a
network boundary (HTTP gateway, SSH tunnel, container exposed to multiple
users), assume the worst and put auth + quotas in front of it.
