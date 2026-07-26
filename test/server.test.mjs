// MCP tool-input schema validation tests. These exercise validateToolArgs
// directly so we can assert the surface without a real MCP client.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  validateToolArgs,
  GEMINI_TOOL,
  GEMINI_TOOL_WITH_CONTEXT,
  GEMINI_TOOL_STRUCTURED,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

test("runtime PACKAGE_VERSION matches package.json version (AUDIT-CORR-004 regression)", () => {
  // The server reads its version dynamically from package.json. Confirm the
  // compiled module reports the same version string that package.json declares
  // by sending an MCP initialize request and inspecting the serverInfo.
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

  const initMsg = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  });
  const readyMsg = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });

  const input = `${initMsg}\n${readyMsg}\n`;
  const child = spawnSync("node", [path.join(rootDir, "dist", "index.js")], {
    input,
    encoding: "utf8",
    cwd: rootDir,
    timeout: 5_000,
    killSignal: "SIGTERM",
  });
  const stdout = child.stdout ?? "";
  assert.ok(stdout.length > 0, child.stderr || child.error?.message);

  const lines = stdout.trim().split("\n");
  const initResponse = JSON.parse(lines[0]);
  assert.equal(
    initResponse.result.serverInfo.version,
    pkg.version,
    "runtime server version should match package.json version"
  );
});

test("importing from an unrelated dist/index.js does not auto-start stdio", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(path.dirname(rootDir), "geminicli-mcp-import-")
  );
  const scriptDir = path.join(tempRoot, "dist");
  const scriptPath = path.join(scriptDir, "index.js");
  fs.mkdirSync(scriptDir);
  fs.writeFileSync(
    scriptPath,
    `import(${JSON.stringify(
      pathToFileURL(path.join(rootDir, "dist", "index.js")).href
    )}).then(() => console.log("imported"));\n`
  );
  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "import-test", version: "0.0.0" },
    },
  });
  try {
    const child = spawnSync(process.execPath, [scriptPath], {
      input: `${init}\n`,
      encoding: "utf8",
      cwd: tempRoot,
      timeout: 5_000,
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), "imported");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("validateToolArgs: gemini_prompt requires a non-empty string prompt", () => {
  assert.throws(
    () => validateToolArgs(GEMINI_TOOL.name, {}),
    /prompt.*must be a string/
  );
  assert.throws(
    () => validateToolArgs(GEMINI_TOOL.name, { prompt: 42 }),
    /prompt.*must be a string/
  );
  assert.throws(
    () => validateToolArgs(GEMINI_TOOL.name, { prompt: "" }),
    /non-empty/
  );
  assert.throws(
    () => validateToolArgs(GEMINI_TOOL.name, null),
    /arguments must be an object/
  );
  assert.throws(
    () => validateToolArgs(GEMINI_TOOL.name, []),
    /arguments must be an object/
  );
  assert.throws(
    () => validateToolArgs(GEMINI_TOOL.name, { prompt: "before\0after" }),
    /NUL/
  );
});

test("validateToolArgs rejects arguments not declared by each tool", () => {
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL.name, {
        prompt: "hi",
        working_dir: "/tmp",
      }),
    /Unexpected argument.*working_dir/
  );
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_WITH_CONTEXT.name, {
        prompt: "hi",
        context: "ctx",
        schema: {},
      }),
    /Unexpected argument.*schema/
  );
});

test("validateToolArgs: gemini_prompt rejects non-string model", () => {
  assert.throws(
    () => validateToolArgs(GEMINI_TOOL.name, { prompt: "hi", model: 7 }),
    /model.*must be a string/
  );
});

test("validateToolArgs: gemini_prompt rejects flag-shaped model values", () => {
  // argv-flag injection: a model starting with '-' or containing whitespace
  // could be re-parsed by the gemini CLI as another flag.
  for (const bad of ["", "--help", "-p evil", "gemini 2.5", " ", "\tfoo"]) {
    assert.throws(
      () => validateToolArgs(GEMINI_TOOL.name, { prompt: "hi", model: bad }),
      /model.*must match/,
      `should reject model=${JSON.stringify(bad)}`
    );
  }
});

test("validateToolArgs: gemini_prompt accepts realistic model IDs", () => {
  for (const good of [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-1.5-pro-latest",
    "models.gemini-2.5",
  ]) {
    const out = validateToolArgs(GEMINI_TOOL.name, {
      prompt: "hi",
      model: good,
    });
    assert.equal(out.model, good, `should accept model=${good}`);
  }
});

test("validateToolArgs: gemini_prompt accepts minimal valid args", () => {
  const out = validateToolArgs(GEMINI_TOOL.name, { prompt: "hi" });
  assert.equal(out.kind, "prompt");
  assert.equal(out.prompt, "hi");
  assert.equal(out.model, undefined);
});

test("validateToolArgs: gemini_prompt_with_context requires context as string", () => {
  assert.throws(
    () => validateToolArgs(GEMINI_TOOL_WITH_CONTEXT.name, { prompt: "hi" }),
    /context.*must be a string/
  );
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_WITH_CONTEXT.name, {
        prompt: "hi",
        context: 123,
      }),
    /context.*must be a string/
  );
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_WITH_CONTEXT.name, {
        prompt: "hi",
        context: "before\0after",
      }),
    /context.*NUL/
  );
});

test("validateToolArgs: gemini_prompt_with_context accepts well-formed args", () => {
  const out = validateToolArgs(GEMINI_TOOL_WITH_CONTEXT.name, {
    prompt: "hi",
    context: "ctx",
  });
  assert.equal(out.kind, "context");
  assert.equal(out.context, "ctx");
});

test("validateToolArgs: gemini_prompt_structured requires schema object", () => {
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_STRUCTURED.name, { prompt: "hi" }),
    /schema.*must be a JSON Schema object/
  );
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_STRUCTURED.name, {
        prompt: "hi",
        schema: "not-an-object",
      }),
    /schema.*must be a JSON Schema object/
  );
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_STRUCTURED.name, {
        prompt: "hi",
        schema: [1, 2, 3],
      }),
    /schema.*must be a JSON Schema object/
  );
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_STRUCTURED.name, {
        prompt: "hi",
        schema: null,
      }),
    /schema.*must be a JSON Schema object/
  );
});

test("validateToolArgs: gemini_prompt_structured accepts schema + optional context", () => {
  const out = validateToolArgs(GEMINI_TOOL_STRUCTURED.name, {
    prompt: "give me JSON",
    schema: { type: "object", properties: { x: { type: "number" } } },
    context: "background",
    model: "gemini-2.5-pro",
  });
  assert.equal(out.kind, "structured");
  assert.equal(out.prompt, "give me JSON");
  assert.equal(out.context, "background");
  assert.equal(out.model, "gemini-2.5-pro");
  assert.deepEqual(out.schema, {
    type: "object",
    properties: { x: { type: "number" } },
  });
});

test("validateToolArgs: gemini_prompt_structured rejects malformed nested schemas", () => {
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_STRUCTURED.name, {
        prompt: "hi",
        schema: { properties: { broken: 1 } },
      }),
    /Invalid `schema`.*must be a schema object/s
  );
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_STRUCTURED.name, {
        prompt: "hi",
        schema: { allOf: [null] },
      }),
    /Invalid `schema`.*must be a schema object/s
  );
});

test("validateToolArgs: gemini_prompt_structured rejects non-string context", () => {
  assert.throws(
    () =>
      validateToolArgs(GEMINI_TOOL_STRUCTURED.name, {
        prompt: "hi",
        schema: { type: "object" },
        context: 9,
      }),
    /context.*must be a string/
  );
});

test("validateToolArgs: rejects unknown tool names", () => {
  assert.throws(
    () => validateToolArgs("not_a_tool", { prompt: "hi" }),
    /Unknown tool/
  );
});

test("MCP tool definitions advertise the three expected tools", () => {
  assert.equal(GEMINI_TOOL.name, "gemini_prompt");
  assert.equal(GEMINI_TOOL_WITH_CONTEXT.name, "gemini_prompt_with_context");
  assert.equal(GEMINI_TOOL_STRUCTURED.name, "gemini_prompt_structured");

  // Each input schema must mark its required fields.
  assert.deepEqual(GEMINI_TOOL.inputSchema.required, ["prompt"]);
  assert.deepEqual(GEMINI_TOOL_WITH_CONTEXT.inputSchema.required, [
    "prompt",
    "context",
  ]);
  assert.deepEqual(GEMINI_TOOL_STRUCTURED.inputSchema.required, [
    "prompt",
    "schema",
  ]);
  for (const tool of [
    GEMINI_TOOL,
    GEMINI_TOOL_WITH_CONTEXT,
    GEMINI_TOOL_STRUCTURED,
  ]) {
    assert.equal(tool.inputSchema.properties.prompt.minLength, 1);
    assert.equal(
      tool.inputSchema.properties.model.pattern,
      "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
    );
  }

  // additionalProperties must be off so callers can't sneak in extra fields.
  assert.equal(GEMINI_TOOL.inputSchema.additionalProperties, false);
  assert.equal(GEMINI_TOOL_WITH_CONTEXT.inputSchema.additionalProperties, false);
  assert.equal(GEMINI_TOOL_STRUCTURED.inputSchema.additionalProperties, false);
});
