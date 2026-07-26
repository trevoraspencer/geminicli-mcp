# Contributing to geminicli-mcp

Thanks for your interest. This project is intentionally small — a stateless
stdio MCP server that shells out to the headless Gemini CLI — and the bar for
keeping it that way is high. Before opening a PR, please read the repository
instructions in [`AGENTS.md`](./AGENTS.md). Some design invariants look like
"missing features" but are load-bearing.

## Local development

Requirements:

- Node.js 20 or newer (`engines.node = ">=20"`).
- The headless `gemini` CLI on your `PATH` if you want to run live tests
  (`@google/gemini-cli`). Set `GEMINI_CLI_BIN` to override the binary path.

```bash
npm install
npm run build       # compile src/ -> dist/
npm test            # offline node:test suite (no CLI required)
npm run test:live   # also runs tests that actually spawn `gemini`
```

`npm test` requires a fresh `npm run build` because the test files import the
compiled `dist/invoke.js` (this is intentional — we test the shipped artifact).

Run a single test by name:

```bash
node --test --test-name-pattern="classifyExitCode" test/integration.test.mjs
```

## Project layout

```
src/
  index.ts    # MCP server: registers the three tools, validates input,
              # delegates to invoke.ts.
  invoke.ts   # spawn() the Gemini CLI; child env inherits server env + NO_COLOR/TERM.
  schema.ts   # tiny JSON-Schema-subset validator for the structured tool.
test/
  *.test.mjs  # node:test suite. No third-party test framework.
```

## Design invariants — do not "fix" these

These are deliberate. PRs that change them will be declined unless they
include a strong rationale and discussion in an issue first.

- **Stateless.** No session IDs, no `--resume`, no `working_dir` parameter.
  The child process runs in `process.cwd()`.
- **Spawn-per-client.** One server process per MCP client. No pooling.
- **No timeout enforcement** in the server — the client and the CLI are
  authoritative.
- **Child env inherits the server env**, plus forced `NO_COLOR=1` and
  `TERM=dumb`. The helper is named `childEnv` on purpose: it
  is not a filter. Secrets like `GEMINI_API_KEY` flow through so the
  gemini CLI can use them.
- **No shell interpolation.** The prompt is passed as a single argv element.
  Never concatenate user input into a shell string.
- **One runtime dependency.** `@modelcontextprotocol/sdk` is the only
  permitted runtime dependency. We use a hand-rolled JSON Schema validator
  for `gemini_prompt_structured` rather than pull `ajv`.
- **No third-party test framework.** Stick to `node:test`.

## Pull request expectations

1. **Open an issue first** for anything larger than a typo fix or a
   one-function bug fix. We'd rather agree on the shape before you write
   code.
2. **Branch from `main`.** Keep PRs focused on a single change.
3. **Include tests.** New behaviour needs an offline `node:test` case in
   `test/`. Bug fixes should ship with a regression test.
4. **Run the full check locally** before pushing:
   ```bash
   npm run build && npm run lint && npm test && npm pack --dry-run
   ```
   Required PR CI runs the same checks on current Node/Linux. Broader Node and
   OS coverage lives in the manual compatibility workflow.
5. **Update docs** (`README.md`, `CHANGELOG.md`) when you change observable
   behaviour. Add a `## [Unreleased]` section to `CHANGELOG.md` if one is
   not already present.
6. **No new runtime dependencies** without explicit discussion in the
   issue.
7. **Conventional-ish commit messages** are appreciated but not required —
   what matters is that the PR description explains *why* the change is
   needed.

## Release process

For maintainers cutting a release:

1. Bump the version in `package.json` — this is the single source of truth;
   `src/index.ts` reads the version dynamically at startup via
   `fs.readFileSync`, so there is no separate version constant to update:
   ```bash
   # in package.json: bump "version"
   ```
2. Run `npm install` to refresh `package-lock.json` with the new version.
3. In `CHANGELOG.md`, rename the `[Unreleased]` section to
   `[X.Y.Z] - YYYY-MM-DD` and add a fresh empty `[Unreleased]` placeholder
   above it. Update the comparison links at the bottom.
4. Verify locally:
   ```bash
   npm run build && npm run lint && npm test && npm pack --dry-run
   ```
5. Commit, tag, and push:
   ```bash
   git commit -am "Release vX.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
6. Publish:
   ```bash
   npm publish      # prepublishOnly rebuilds, lints, and tests
   ```
7. Open a GitHub release for the tag and paste the changelog section into it.

## Security issues

See [`SECURITY.md`](./SECURITY.md). Do not file public issues for
vulnerabilities.

## Reporting bugs

Please include:

- Your Node.js version (`node --version`) and OS.
- The `gemini` CLI version (`gemini --version`) if relevant.
- The exact MCP `tools/call` request (or a minimal reproducer) and the
  `isError` / `text` result you observed.

Open an issue at
<https://github.com/trevoraspencer/geminicli-mcp/issues>.

## License

By contributing you agree that your contributions will be licensed under the
MIT License (see `LICENSE`).
