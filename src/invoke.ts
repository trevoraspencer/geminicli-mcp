/**
 * invoke.ts — spawn the headless Gemini CLI with inherited child env and argv array.
 *
 * Stateless, no shell interpolation, defensive JSON parsing.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import {
  extractJson,
  formatErrors,
  validate,
  validateSchemaDefinition,
  type JsonSchema,
} from "./schema.js";

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
    | "sandbox_error"
    | "config_error"
    | "turn_limit"
    | "cancelled"
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
  // Number.parseInt("1024garbage", 10) is 1024. Treat the setting as a
  // configuration value, not a prefix, so a typo cannot silently reduce the
  // output budget and truncate otherwise-valid responses.
  if (!/^[1-9]\d*$/.test(env)) return DEFAULT_MAX_OUTPUT_BYTES;
  const n = Number(env);
  return Number.isSafeInteger(n) ? n : DEFAULT_MAX_OUTPUT_BYTES;
}

/**
 * Grace period between the initial SIGTERM and the SIGKILL escalation once
 * the server has decided to kill the child (output cap exceeded or caller
 * abort). A child that traps or ignores SIGTERM would otherwise never emit
 * `close`, leaving the MCP call pending forever while the child burns CPU.
 * This is kill reliability, not server-side timeout enforcement: the timer
 * is only armed after a kill decision, and it is unref'd so it can never
 * hold the server process open.
 */
const SIGKILL_GRACE_MS = 2000;

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
    case 44:
      return "sandbox_error";
    case 52:
      return "config_error";
    case 53:
      return "turn_limit";
    case 130:
      return "cancelled";
    case 127:
      // Binary not found — matches the README exit-code table and the
      // synthesized ENOENT result from spawnErrorResult().
      return "error";
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
  // Some CLI versions have emitted a diagnostic line before pretty-printed
  // JSON. No individual line is valid JSON in that shape, but the balanced
  // extractor can still recover the complete value.
  const candidate = extractJson(trimmed);
  if (candidate !== undefined) {
    try {
      return JSON.parse(candidate);
    } catch {
      // The caller will fall back to the raw output.
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
  if (inv.context !== undefined) {
    return `<context>\n${inv.context}\n</context>\n\n${inv.prompt}`;
  }
  return inv.prompt;
}

/**
 * Build the argv array for the Gemini CLI.
 *
 * Flag ordering is intentional: the prompt first, then JSON output, workspace
 * trust, YOLO approval, and the optional model. User-controlled option values
 * use `--name=value` so a prompt such as `--help` cannot be reinterpreted by
 * Gemini's argument parser as another flag. Every argument remains a separate
 * argv element — nothing is interpolated into a shell string.
 */
export function buildArgv(inv: GeminiInvocation): string[] {
  const prompt = composePrompt(inv);
  const argv: string[] = [
    `--prompt=${prompt}`,
    "--output-format",
    "json",
    "--skip-trust",
    "--approval-mode",
    "yolo",
  ];
  if (inv.model) {
    argv.push(`--model=${inv.model}`);
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
      // A separate process group lets cancellation/output-cap enforcement
      // terminate tools spawned by Gemini too, rather than orphaning them.
      // Windows has no negative-PID process-group signalling, so it keeps the
      // regular ChildProcess behaviour.
      detached: process.platform !== "win32",
    });

    if (debugEnabled()) {
      debugLog("invoke start", {
        bin,
        argv: argv.map((arg) =>
          arg.startsWith("--prompt=")
            ? `<prompt ${arg.length - "--prompt=".length} chars>`
            : arg
        ),
      });
    }

    const cap = maxOutputBytes();
    // Collect chunks into arrays for O(n) accumulation instead of O(k·n)
    // string concatenation (AUDIT-PERF-001).
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    // One stateful decoder per stream: a multibyte UTF-8 sequence split
    // across two pipe chunks must not decode to U+FFFD replacement chars,
    // which per-chunk Buffer#toString("utf8") produced.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    // Byte counts (Buffer lengths) — the cap is documented as bytes, so it
    // must not count UTF-16 code units of the decoded text.
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let aborted = false;
    let killed = false;
    let killFailed = false;
    let killTimer: NodeJS.Timeout | undefined;
    const startTime = Date.now();

    const signalChildTree = (signalName: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signalName);
          return;
        } catch {
          // The group may have disappeared between the output/abort event and
          // this call. Fall back to the direct child for portability and for
          // unusual platforms that do not implement negative-PID signalling.
        }
      }
      child.kill(signalName);
    };

    const killWith = (reason: "truncated" | "aborted") => {
      if (reason === "truncated") truncated = true;
      if (reason === "aborted") aborted = true;
      // A second reason can arrive while termination is in flight (for
      // example, the caller aborts just after the output cap fires). Preserve
      // all observed result metadata, but only signal the child once.
      if (killed) return;
      killed = true;
      try {
        signalChildTree("SIGTERM");
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
      // Escalate to SIGKILL if the child ignores SIGTERM — a runaway child
      // is exactly the adversary the output cap exists for. The timer is
      // unref'd and cleared on close, so a cooperative child sees no change.
      killTimer = setTimeout(() => {
        try {
          signalChildTree("SIGKILL");
        } catch {
          // Child is already gone (or unkillable); close/error handles it.
        }
      }, SIGKILL_GRACE_MS);
      killTimer.unref();
    };

    const onAbort = () => killWith("aborted");
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c: Buffer) => {
      if (stdoutLen + c.length > cap) {
        const room = Math.max(0, cap - stdoutLen);
        if (room > 0) {
          // Decode only the bytes that fit; the decoder withholds any
          // trailing partial character instead of emitting U+FFFD.
          const slice = stdoutDecoder.write(c.subarray(0, room));
          if (slice.length > 0) stdoutChunks.push(slice);
          stdoutLen += room;
        }
        killWith("truncated");
      } else {
        const chunk = stdoutDecoder.write(c);
        if (chunk.length > 0) stdoutChunks.push(chunk);
        stdoutLen += c.length;
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderrLen + c.length > cap) {
        const room = Math.max(0, cap - stderrLen);
        if (room > 0) {
          const slice = stderrDecoder.write(c.subarray(0, room));
          if (slice.length > 0) stderrChunks.push(slice);
          stderrLen += room;
        }
        killWith("truncated");
      } else {
        const chunk = stderrDecoder.write(c);
        if (chunk.length > 0) stderrChunks.push(chunk);
        stderrLen += c.length;
      }
    });

    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code, sigName) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (killTimer) {
        let keepGroupEscalation = false;
        if (
          killed &&
          process.platform !== "win32" &&
          child.pid !== undefined
        ) {
          try {
            // The direct child can close while a descendant that redirected
            // stdio remains in its process group. Keep the pending SIGKILL in
            // that case; clearing it here would orphan the descendant.
            process.kill(-child.pid, 0);
            keepGroupEscalation = true;
          } catch {
            // No process remains in the group.
          }
        }
        if (!keepGroupEscalation) clearTimeout(killTimer);
      }
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
      // Flush any bytes still buffered in the decoders. A stream that ended
      // mid-character (truncated at the byte cap or killed mid-write) yields
      // the standard U+FFFD replacement character here, same as
      // readable.setEncoding would.
      const stdoutTail = stdoutDecoder.end();
      if (stdoutTail.length > 0) stdoutChunks.push(stdoutTail);
      const stderrTail = stderrDecoder.end();
      if (stderrTail.length > 0) stderrChunks.push(stderrTail);
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
  const { stdout, stderr, truncated, aborted } = outcome;
  // A child may trap SIGTERM and deliberately exit 0. Cancellation and output
  // truncation still mean the response is incomplete and must never be
  // surfaced to MCP clients as a successful tool result.
  const exitCode =
    outcome.exitCode === 0 && aborted
      ? 130
      : outcome.exitCode === 0 && truncated
        ? 1
        : outcome.exitCode;
  const parsed = tryParseJson(stdout);
  let text: string | undefined;
  if (parsed && typeof parsed === "object" && parsed !== null) {
    const p = parsed as Record<string, unknown>;
    const errorMessage =
      p.error &&
      typeof p.error === "object" &&
      typeof (p.error as Record<string, unknown>).message === "string"
        ? ((p.error as Record<string, unknown>).message as string)
        : undefined;
    // Gemini CLI failures commonly use
    // { response: "", error: { message, ... } }. Prefer the actual error on a
    // failed invocation; otherwise the empty response masks it and the caller
    // only sees a generic "gemini exited N" message.
    if (exitCode !== 0 && errorMessage) text = errorMessage;
    else if (typeof p.response === "string") text = p.response;
    else if (typeof p.text === "string") text = p.text;
    else if (typeof p.output === "string") text = p.output;
    else if (errorMessage) text = errorMessage;
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
 * Build a structured GeminiResult for spawn errors (ENOENT, E2BIG, EACCES,
 * EPERM, EFTYPE).
 * ENOENT maps to exit code 127 (command not found); EACCES/EPERM map to
 * exit code 126 (not executable), following POSIX conventions.
 */
function spawnErrorResult(code: string): GeminiResult {
  const bin = geminiBin();
  if (code === "E2BIG") {
    return {
      text:
        "The prompt and context are too large for this operating system's " +
        "process argument limit. Reduce the input size and try again.",
      exitCode: 42,
      errorKind: "input_validation",
      raw: "",
    };
  }
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
    code === "E2BIG" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EFTYPE"
  );
}

/**
 * Discriminated union returned by {@link safeRunCli}: either a normal
 * {@link SpawnOutcome} from a successful spawn, or a structured
 * {@link GeminiResult} produced when the spawn itself failed with a handled
 * error (ENOENT / E2BIG / EACCES / EPERM / EFTYPE). This lets callers avoid
 * duplicating the try/catch + spawn-error-classification logic.
 */
type SafeCliResult =
  | { kind: "outcome"; value: SpawnOutcome }
  | { kind: "spawn_error"; value: GeminiResult };

/**
 * Run the CLI and convert handled spawn errors into structured GeminiResults
 * so callers never need to duplicate the
 * ENOENT/E2BIG/EACCES/EPERM/EFTYPE catch logic.
 */
async function safeRunCli(
  argv: string[],
  options: InvokeOptions = {}
): Promise<SafeCliResult> {
  try {
    return { kind: "outcome", value: await runCli(argv, options) };
  } catch (err) {
    if (isHandledSpawnError(err)) {
      // Type guard confirms code is one of the handled values, never undefined.
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
  const schemaErrors = validateSchemaDefinition(inv.schema);
  if (schemaErrors.length > 0) {
    return {
      text: `Invalid JSON Schema:\n${formatErrors(schemaErrors)}`,
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
  const schemaErrors = validateSchemaDefinition(schema);
  if (schemaErrors.length > 0) {
    return {
      ...base,
      text: `Invalid JSON Schema:\n${formatErrors(schemaErrors)}`,
      exitCode: 42,
      errorKind: "input_validation",
    };
  }
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
    let received: string;
    try {
      received = JSON.stringify(parsed, null, 2);
    } catch {
      // Extremely deep JSON can exceed JSON.stringify's call stack. The raw
      // model text is already output-capped and is safer than throwing out of
      // the MCP request handler while formatting a validation failure.
      received = base.text;
    }
    return {
      ...base,
      text:
        `Gemini response did not match schema:\n${formatErrors(errors)}\n--- received ---\n${received}`,
      exitCode: 1,
      errorKind: "error",
    };
  }

  let canonical: string;
  try {
    const serialized = JSON.stringify(parsed);
    if (serialized === undefined) {
      throw new Error("JSON.stringify returned no value");
    }
    canonical = serialized;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      text: `Gemini structured response could not be serialized safely: ${message}`,
      exitCode: 1,
      errorKind: "error",
    };
  }
  return {
    ...base,
    value: parsed,
    text: canonical,
  };
}
