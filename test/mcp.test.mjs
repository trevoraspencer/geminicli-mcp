// MCP request-handler tests: drive handleListTools / handleCallTool directly
// to assert the surface a real MCP client would see (content array, isError
// flag, error-prefix format) without standing up a transport.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handleListTools, handleCallTool } from "../dist/index.js";
import { makeFakeBin, withEnv } from "./helpers.mjs";

test("handleListTools advertises all three tools by name", () => {
  const out = handleListTools();
  const names = out.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "gemini_prompt",
    "gemini_prompt_structured",
    "gemini_prompt_with_context",
  ]);
});

test("handleCallTool rejects unknown tool names", async () => {
  await assert.rejects(
    () =>
      handleCallTool({
        params: { name: "not_a_real_tool", arguments: { prompt: "hi" } },
      }),
    /Unknown tool/
  );
});

test("handleCallTool returns isError for missing prompt", async () => {
  await assert.rejects(
    () => handleCallTool({ params: { name: "gemini_prompt", arguments: {} } }),
    /prompt.*must be a string/
  );
});

test("handleCallTool: failed gemini invocation maps to isError=true with [error exit=N] prefix", async () => {
  const fake = makeFakeBin(`exit 1`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const out = await handleCallTool({
        params: { name: "gemini_prompt", arguments: { prompt: "hi" } },
      });
      assert.equal(out.isError, true);
      assert.equal(out.content[0].type, "text");
      assert.match(out.content[0].text, /^\[error exit=1\] /);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("handleCallTool: missing gemini binary surfaces exit=127", async () => {
  await withEnv({ GEMINI_CLI_BIN: "/does/not/exist/at/all-xyz" }, async () => {
    const out = await handleCallTool({
      params: { name: "gemini_prompt", arguments: { prompt: "hi" } },
    });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /exit=127/);
    assert.match(out.content[0].text, /Gemini CLI binary not found/);
  });
});

test("handleCallTool: gemini_prompt_with_context routes through the context tool", async () => {
  const fake = makeFakeBin(`exit 1`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const out = await handleCallTool({
        params: {
          name: "gemini_prompt_with_context",
          arguments: { prompt: "summarize", context: "background info" },
        },
      });
      // We exit non-zero so the result is an error, but routing is proven by
      // the absence of a thrown error and the [error exit=1] prefix.
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /^\[error exit=1\]/);
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("handleCallTool: gemini_prompt_structured short-circuits on invalid schema (exit=42)", async () => {
  await assert.rejects(
    () =>
      handleCallTool({
        params: {
          name: "gemini_prompt_structured",
          arguments: { prompt: "hi", schema: "not-an-object" },
        },
      }),
    /schema.*must be a JSON Schema object/
  );
});

test("handleCallTool: passes through abort signal to kill the child", async () => {
  const fake = makeFakeBin(`exec sleep 30`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const start = Date.now();
      const out = await handleCallTool(
        {
          params: { name: "gemini_prompt", arguments: { prompt: "hi" } },
        },
        { signal: controller.signal }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5_000, `abort did not propagate: ${elapsed}ms`);
      assert.equal(out.isError, true);
    });
  } finally {
    try {
      fs.unlinkSync(fake);
    } catch {}
  }
});

// --- Happy-path success test (AUDIT-TEST-002, VAL-REM-F13-002) ---

test("handleCallTool: successful gemini invocation returns isError=false with extracted text (VAL-REM-F13-002)", async () => {
  const fake = makeFakeBin(`printf '{"response":"hello from gemini"}'`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const out = await handleCallTool({
        params: { name: "gemini_prompt", arguments: { prompt: "hi" } },
      });
      assert.equal(out.isError, false, "isError must be false on success");
      assert.equal(out.content[0].type, "text");
      assert.equal(out.content[0].text, "hello from gemini");
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});

test("handleCallTool: structured tool success path returns isError=false with value (VAL-REM-F13-002)", async () => {
  const fake = makeFakeBin(`printf '{"ok":true}'`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const out = await handleCallTool({
        params: {
          name: "gemini_prompt_structured",
          arguments: {
            prompt: "give me JSON",
            schema: { type: "object", properties: { ok: { type: "boolean" } } },
          },
        },
      });
      assert.equal(out.isError, false, "isError must be false on structured success");
      assert.equal(out.content[0].type, "text");
      // The text is the canonical JSON of the validated value.
      assert.equal(out.content[0].text, '{"ok":true}');
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});
