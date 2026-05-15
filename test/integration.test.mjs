import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeGemini, classifyExitCode, tryParseJson } from "../dist/invoke.js";

const LIVE = process.env.GEMINICLI_MCP_LIVE === "1";

test("classifyExitCode maps documented codes", () => {
  assert.equal(classifyExitCode(0), "ok");
  assert.equal(classifyExitCode(1), "error");
  assert.equal(classifyExitCode(41), "auth_required");
  assert.equal(classifyExitCode(42), "input_validation");
  assert.equal(classifyExitCode(53), "turn_limit");
  assert.equal(classifyExitCode(99), "unknown");
});

test("tryParseJson strips non-JSON leading lines", () => {
  const raw = 'some log line\nwarning: x\n{"response":"hi"}\n';
  const out = tryParseJson(raw);
  assert.deepEqual(out, { response: "hi" });
});

test("live: gemini returns non-empty text for tiny prompt", { skip: !LIVE }, async () => {
  const r = await invokeGemini({ prompt: "Reply with the single word: ping" });
  assert.equal(r.errorKind, "ok");
  assert.equal(r.exitCode, 0);
  assert.ok(r.text.length > 0, "expected non-empty response");
});
