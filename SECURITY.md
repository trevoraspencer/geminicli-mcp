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

- **`--approval-mode yolo` is always on.** The server hardcodes this flag
  so it can run non-interactively. Any tool calls or file edits the gemini
  CLI performs are auto-approved. **Do not expose this MCP server to MCP
  clients you do not trust.**
- **Child env inherits the server env.** Anything in the server's
  environment — including `GEMINI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
  shell history, dotfile secrets — is visible to the gemini child and to
  any tool gemini decides to invoke. Treat the server's env as part of the
  trust boundary.
- **No quota or rate limiting.** A caller that can reach the server can
  make unlimited gemini API calls at your expense. Gate access at the
  MCP-client layer.
- **No prompt sanitisation.** Prompts are passed verbatim to the gemini CLI
  via argv. We rely on argv-as-array (no shell interpolation) and on
  validating the optional `model` argument; everything else is the gemini
  CLI's responsibility.
- **No timeout enforcement** in the server. The client is authoritative on
  cancellation; the server honours the MCP request's `AbortSignal` and a
  per-stream output cap (`GEMINICLI_MCP_MAX_OUTPUT_BYTES`, default 32 MiB)
  to prevent a runaway child from OOM-ing the host, but there is no
  wall-clock timeout.

If your deployment puts this server behind anything that smells like a
network boundary (HTTP gateway, SSH tunnel, container exposed to multiple
users), assume the worst and put auth + quotas in front of it.
