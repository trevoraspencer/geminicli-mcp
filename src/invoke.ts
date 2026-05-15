/**
 * invoke.ts — spawn the headless Gemini CLI with inherited child env and argv array.
 *
 * Stateless, no shell interpolation, defensive JSON parsing.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { extractJson, formatErrors, validate, type JsonSchema } from "./schema.js";

/**
 * Whether debug diagnostics are enabled. When `GEMINICLI_MCP_DEBUG` is set to
 * any truthy value, structured diagnostics are emitted to stderr.
 */
export function debugEnabled(): boolean {
  const val = process.env.GEMINICLI_MCP_DEBUG;
  return val === "1" || val === "true" || val === "yes";
}

/**
 * Emit a structured debug diagnostic to stderr.
 * Format: `geminicli-mcp:debug <JSON-object>\n`
 *
 * Must only be called when `debugEnabled()` returns true.
 * Writes to stderr so MCP stdout protocol is never corrupted.
 */
function debugLog(message: string, data: Record<string, unknown>): void {
  const entry = { msg: message, ...data, ts: Date.now() };
  process.stderr.write(`geminicli-mcp:debug ${JSON.stringify(entry)}\n`);
}

export interface GeminiInvocation {
  prompt: string;
  model?: string;
  context?: string;
}

export interface GeminiResult {
  text: string;
  exitCode: number;
  errorKind?:
    | "ok"
    | "error"
    | "auth_required"
    | "input_validation"
    | "turn_limit"
    | "unknown";
  raw: string;
  /** Raw stderr from the child process, if any. */
  stderr?: string;
  /** True when output was truncated because it exceeded the byte cap. */
  truncated?: boolean;
  /** True when the child was killed because the caller's AbortSignal fired. */
  aborted?: boolean;
}

export interface InvokeOptions {
  /** Aborts the in-flight child process (SIGTERM). Honoured by `runCli`. */
  signal?: AbortSignal;
}

/**
 * Default cap on bytes accumulated from the child's stdout or stderr.
 * Overridable per-process via `GEMINICLI_MCP_MAX_OUTPUT_BYTES`. The cap is
 * per-stream — stdout and stderr each get their own budget — so the total
 * memory footprint can reach ~2× this number.
 */
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function maxOutputBytes(): number {
  const env = process.env.GEMINICLI_MCP_MAX_OUTPUT_BYTES;
  if (!env) return DEFAULT_MAX_OUTPUT_BYTES;
  const n = Number.parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_OUTPUT_BYTES;
}

export interface GeminiStructuredInvocation extends GeminiInvocation {
  schema: JsonSchema;
}

export interface GeminiStructuredResult extends GeminiResult {
  /** parsed + validated JSON value, when exitCode === 0 and validation passed. */
  value?: unknown;
}

export function classifyExitCode(
  code: number
): Exclude<NonNullable<GeminiResult["errorKind"]>, undefined> {
  switch (code) {
    case 0:
      return "ok";
    case 1:
      return "error";
    case 41:
      // Gemini CLI exits 41 when authentication is missing or invalid.
      return "auth_required";
    case 42:
      return "input_validation";
    case 53:
      return "turn_limit";
    default:
      return "unknown";
  }
}

/**
 * Resolve the Gemini CLI binary path. Re-evaluated on every call so the
 * `GEMINI_CLI_BIN` environment variable can be changed at runtime (this also
 * makes the behaviour straightforward to test).
 */
function geminiBin(): string {
  return process.env.GEMINI_CLI_BIN ?? "gemini";
}

/**
 * Map a signal name (e.g. "SIGTERM", "SIGKILL") to its signal number using
 * `os.constants.signals`. Returns `undefined` for unknown signal names.
 * Exported for testability.
 */
export function signalNameToNumber(sigName: string): number | undefined {
  const signals = os.constants.signals as Record<string, number>;
  return signals[sigName];
}

/**
 * Strip non-JSON lines from stdout and return the first parseable JSON object.
 * Returns undefined if no JSON could be found.
 *
 * Tries the whole buffer first (common case for `--output-format json` output),
 * then falls back to line-by-line scanning when the whole-buffer parse fails.
 */
export function tryParseJson(raw: string): unknown | undefined {
  // Fast path: try whole-buffer parse first.
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Whole-buffer parse failed; fall through to line-by-line scan.
    }
  }
  // Slow path: scan line by line for the first parseable JSON value.
  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    const lt = line.trim();
    if (!lt.startsWith("{") && !lt.startsWith("[")) continue;
    try {
      return JSON.parse(lt);
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

/**
 * Build the env passed to the child gemini process. The server's full
 * environment is inherited (so `GEMINI_API_KEY` and similar flow through),
 * with `NO_COLOR=1` and `TERM=dumb` forced on top to keep the CLI's stdout
 * machine-parseable. Despite the historic name, this is NOT a sanitizer:
 * callers must not place secrets in the server's env that they would not be
 * willing to give the gemini CLI.
 */
export function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

/**
 * Compose the final prompt string sent to the CLI.
 * Exposed for testing: callers should not need to build it themselves.
 */
export function composePrompt(inv: GeminiInvocation): string {
  if (inv.context && inv.context.length > 0) {
    return `<context>\n${inv.context}\n</context>\n\n${inv.prompt}`;
  }
  return inv.prompt;
}

/**
 * Build the argv array for the Gemini CLI.
 *
 * Flag ordering is intentional: `-p <prompt>` first, then `--output-format json`,
 * then `--approval-mode yolo`, then optional `--model <id>`. The prompt is always
 * a separate argv element — never interpolated into a shell string.
 */
export function buildArgv(inv: GeminiInvocation): string[] {
  const argv: string[] = [
    "-p",
    composePrompt(inv),
    "--output-format",
    "json",
    "--approval-mode",
    "yolo",
  ];
  if (inv.model) {
    argv.push("--model", inv.model);
  }
  return argv;
}

interface SpawnOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if the child was killed for exceeding the output cap. */
  truncated?: boolean;
  /** True if the child was killed because the caller's abort signal fired. */
  aborted?: boolean;
  /** True if child.kill("SIGTERM") threw during the kill attempt. */
  killFailed?: boolean;
}

function runCli(
  argv: string[],
  options: InvokeOptions = {}
): Promise<SpawnOutcome> {
  return new Promise<SpawnOutcome>((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      resolve({ exitCode: 130, stdout: "", stderr: "", aborted: true });
      return;
    }

    const bin = geminiBin();
    const command =
      process.platform === "win32" && /\.(?:c|m)?js$/i.test(bin)
        ? process.execPath
        : bin;
    const commandArgv =
      command === process.execPath && command !== bin ? [bin, ...argv] : argv;

    const child = spawn(command, commandArgv, {
      cwd: process.cwd(),
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (debugEnabled()) {
      debugLog("invoke start", {
        bin,
        argv: argv.map((a, i) => (i === 1 ? `<prompt ${a.length} chars>` : a)),
      });
    }

    const cap = maxOutputBytes();
    // Collect chunks into arrays for O(n) accumulation instead of O(k·n)
    // string concatenation (AUDIT-PERF-001).
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let aborted = false;
    let killed = false;
    let killFailed = false;
    const startTime = Date.now();

    const killWith = (reason: "truncated" | "aborted") => {
      if (killed) return;
      killed = true;
      if (reason === "truncated") truncated = true;
      if (reason === "aborted") aborted = true;
      try {
        child.kill("SIGTERM");
      } catch (killErr) {
        // Record the kill failure for diagnostics (AUDIT-OBS-005).
        killFailed = true;
        if (debugEnabled()) {
          debugLog("SIGTERM kill failed", {
            reason,
            error: killErr instanceof Error ? killErr.message : String(killErr),
          });
        }
      }
    };

    const onAbort = () => killWith("aborted");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c) => {
      const chunk = c.toString("utf8");
      if (stdoutLen + chunk.length > cap) {
        const slice = chunk.slice(0, Math.max(0, cap - stdoutLen));
        if (slice.length > 0) {
          stdoutChunks.push(slice);
          stdoutLen += slice.length;
        }
        killWith("truncated");
      } else {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });
    child.stderr.on("data", (c) => {
      const chunk = c.toString("utf8");
      if (stderrLen + chunk.length > cap) {
        const slice = chunk.slice(0, Math.max(0, cap - stderrLen));
        if (slice.length > 0) {
          stderrChunks.push(slice);
          stderrLen += slice.length;
        }
        killWith("truncated");
      } else {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sigName) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      let exitCode: number;
      if (typeof code === "number") {
        exitCode = code;
      } else if (sigName) {
        // POSIX convention: 128 + signal number for signal-killed processes.
        const sigNum = signalNameToNumber(sigName);
        exitCode = sigNum !== undefined ? 128 + sigNum : 128;
      } else {
        exitCode = 1;
      }
      let stdout = stdoutChunks.join("");
      let stderr = stderrChunks.join("");
      if (truncated) {
        stdout += `\n[geminicli-mcp: output truncated at ${cap} bytes; child killed]`;
      }
      if (aborted) {
        stderr += `\n[geminicli-mcp: cancelled by caller; child killed]`;
      }
      const durationMs = Date.now() - startTime;
      if (debugEnabled()) {
        debugLog("invoke complete", {
          exitCode,
          signal: sigName ?? null,
          truncated,
          aborted,
          killFailed,
          durationMs,
          stdoutLen,
          stderrLen,
        });
      }
      resolve({ exitCode, stdout, stderr, truncated, aborted, killFailed });
    });
  });
}

export function resultFromOutcome(outcome: SpawnOutcome): GeminiResult {
  const { exitCode, stdout, stderr, truncated, aborted } = outcome;
  const parsed = tryParseJson(stdout);
  let text: string | undefined;
  if (parsed && typeof parsed === "object" && parsed !== null) {
    const p = parsed as Record<string, unknown>;
    if (typeof p.response === "string") text = p.response;
    else if (typeof p.text === "string") text = p.text;
    else if (typeof p.output === "string") text = p.output;
    else if (
      p.error &&
      typeof p.error === "object" &&
      typeof (p.error as Record<string, unknown>).message === "string"
    ) {
      // gemini CLI's JSON shape on failure: {response: "", error: {message, ...}}
      text = (p.error as Record<string, unknown>).message as string;
    }
  }
  if (text === undefined) text = stdout.trim();
  if (exitCode !== 0 && !text) {
    text = stderr.trim() || `gemini exited ${exitCode}`;
  }
  return {
    text,
    exitCode,
    errorKind: classifyExitCode(exitCode),
    raw: stdout,
    ...(stderr ? { stderr } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(aborted ? { aborted: true } : {}),
  };
}

/**
 * Build a structured GeminiResult for spawn errors (ENOENT, EACCES, EPERM,
 * EFTYPE).
 * ENOENT maps to exit code 127 (command not found); EACCES/EPERM map to
 * exit code 126 (not executable), following POSIX conventions.
 */
function spawnErrorResult(code: string): GeminiResult {
  const bin = geminiBin();
  if (code === "ENOENT") {
    return {
      text: `Gemini CLI binary not found at '${bin}'. Install @google/gemini-cli or set GEMINI_CLI_BIN.`,
      exitCode: 127,
      errorKind: "error",
      raw: "",
    };
  }
  return {
    text: `Gemini CLI binary at '${bin}' is not executable (${code}). Check file permissions or set GEMINI_CLI_BIN.`,
    exitCode: 126,
    errorKind: "error",
    raw: "",
  };
}

/**
 * Check whether a spawn error is one we convert to structured results.
 */
function isHandledSpawnError(err: unknown): err is NodeJS.ErrnoException {
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EFTYPE"
  );
}

/**
 * Discriminated union returned by {@link safeRunCli}: either a normal
 * {@link SpawnOutcome} from a successful spawn, or a structured
 * {@link GeminiResult} produced when the spawn itself failed with a handled
 * error (ENOENT / EACCES / EPERM / EFTYPE). This lets callers avoid duplicating
 * the try/catch + spawn-error-classification logic.
 */
type SafeCliResult =
  | { kind: "outcome"; value: SpawnOutcome }
  | { kind: "spawn_error"; value: GeminiResult };

/**
 * Run the CLI and convert handled spawn errors into structured GeminiResults
 * so callers never need to duplicate the ENOENT/EACCES/EPERM/EFTYPE catch
 * logic.
 */
async function safeRunCli(
  argv: string[],
  options: InvokeOptions = {}
): Promise<SafeCliResult> {
  try {
    return { kind: "outcome", value: await runCli(argv, options) };
  } catch (err) {
    if (isHandledSpawnError(err)) {
      // Type guard confirms code is one of ENOENT/EACCES/EPERM, never undefined.
      return { kind: "spawn_error", value: spawnErrorResult(err.code ?? "ENOENT") };
    }
    throw err;
  }
}

export async function invokeGemini(
  inv: GeminiInvocation,
  options: InvokeOptions = {}
): Promise<GeminiResult> {
  const argv = buildArgv(inv);
  const result = await safeRunCli(argv, options);
  if (result.kind === "spawn_error") return result.value;
  return resultFromOutcome(result.value);
}

/**
 * Wrap a user prompt so the CLI is told to emit JSON conforming to `schema`.
 */
export function composeStructuredPrompt(
  inv: GeminiStructuredInvocation
): string {
  const userPart = composePrompt(inv);
  const schemaText = JSON.stringify(inv.schema, null, 2);
  return `${userPart}

Respond with a single JSON value that conforms to this JSON Schema. Output ONLY the JSON value — no prose, no markdown fences, no commentary.

JSON Schema:
${schemaText}`;
}

export async function invokeGeminiStructured(
  inv: GeminiStructuredInvocation,
  options: InvokeOptions = {}
): Promise<GeminiStructuredResult> {
  if (!inv.schema || typeof inv.schema !== "object" || Array.isArray(inv.schema)) {
    return {
      text: `'schema' must be a JSON Schema object`,
      exitCode: 42,
      errorKind: "input_validation",
      raw: "",
    };
  }

  const wrappedPrompt = composeStructuredPrompt(inv);
  const argv = buildArgv({
    prompt: wrappedPrompt,
    ...("model" in inv && inv.model ? { model: inv.model } : {}),
  });

  const cliResult = await safeRunCli(argv, options);
  if (cliResult.kind === "spawn_error") return cliResult.value;

  const base = resultFromOutcome(cliResult.value);
  if (base.exitCode !== 0) return base;

  return parseAndValidateStructured(base, inv.schema);
}

/**
 * Pull JSON out of the model's response text and validate it against the schema.
 * Exported so tests can exercise the success and schema-miss paths without
 * actually spawning the CLI.
 */
export function parseAndValidateStructured(
  base: GeminiResult,
  schema: JsonSchema
): GeminiStructuredResult {
  const candidate = extractJson(base.text) ?? base.text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      text: `Gemini structured response is not valid JSON: ${message}\n--- raw response ---\n${base.text}`,
      exitCode: 1,
      errorKind: "error",
    };
  }

  const errors = validate(parsed, schema);
  if (errors.length > 0) {
    return {
      ...base,
      text:
        `Gemini response did not match schema:\n${formatErrors(errors)}\n--- received ---\n${JSON.stringify(parsed, null, 2)}`,
      exitCode: 1,
      errorKind: "error",
    };
  }

  return {
    ...base,
    value: parsed,
    text: JSON.stringify(parsed),
  };
}
