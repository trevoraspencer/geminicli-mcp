// MCP stdio transport integration test (VAL-REM-F12-001).
//
// Spawns `node dist/index.js` as a real MCP stdio server, sends the
// initialize / initialized / tools/list JSON-RPC sequence over stdin,
// and asserts that the tools/list response contains exactly the three
// expected tools. No live Gemini/API calls are made — only the MCP
// protocol layer is exercised.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "..", "dist", "index.js");

/**
 * Read a single newline-delimited JSON-RPC message from the child's stdout.
 * Returns a promise that resolves with the parsed JSON object.
 */
function readResponse(child, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for stdout response (buffer so far: ${JSON.stringify(buffer)})`));
    }, timeoutMs);

    function onData(chunk) {
      buffer += chunk.toString();
      const nlIdx = buffer.indexOf("\n");
      if (nlIdx !== -1) {
        cleanup();
        const line = buffer.slice(0, nlIdx).trim();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(new Error(`failed to parse JSON-RPC response: ${err.message}\nline: ${line}`));
        }
      }
    }

    function onEnd() {
      cleanup();
      reject(new Error(`child exited before response arrived (buffer: ${JSON.stringify(buffer)})`));
    }

    function cleanup() {
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.removeListener("exit", onEnd);
    }

    child.stdout.on("data", onData);
    child.once("exit", onEnd);
  });
}

test("MCP stdio: initialize + tools/list returns exactly 3 tools (VAL-REM-F12-001)", async () => {
  const child = spawn("node", [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    cwd: path.resolve(__dirname, ".."),
  });

  // Drain stderr to avoid backpressure issues; we don't assert on it.
  const stderrChunks = [];
  child.stderr.on("data", (c) => stderrChunks.push(c));

  try {
    // 1. Send initialize request.
    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "1.0.0" },
      },
    });
    child.stdin.write(initMsg + "\n");

    const initResp = await readResponse(child);
    assert.equal(initResp.id, 1, "initialize response id should match request");
    assert.equal(initResp.jsonrpc, "2.0");
    assert.ok(initResp.result, "initialize should return a result");
    assert.equal(initResp.result.serverInfo.name, "geminicli-mcp");

    // 2. Send initialized notification (no id → no response expected).
    const readyMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
    child.stdin.write(readyMsg + "\n");

    // Give the server a tick to process the notification.
    await new Promise((r) => setTimeout(r, 50));

    // 3. Send tools/list request.
    const listMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    child.stdin.write(listMsg + "\n");

    const listResp = await readResponse(child);
    assert.equal(listResp.id, 2, "tools/list response id should match request");
    assert.equal(listResp.jsonrpc, "2.0");
    assert.ok(listResp.result, "tools/list should return a result");
    assert.ok(Array.isArray(listResp.result.tools), "tools should be an array");

    const toolNames = listResp.result.tools.map((t) => t.name).sort();
    assert.deepEqual(
      toolNames,
      [
        "gemini_prompt",
        "gemini_prompt_structured",
        "gemini_prompt_with_context",
      ],
      "tools/list must return exactly the 3 expected tools"
    );
    assert.equal(
      listResp.result.tools.length,
      3,
      "exactly 3 tools in the tools/list response"
    );
  } finally {
    child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

// Regression test: on POSIX, npm installs the `bin` entry as a symlink
// (<prefix>/bin/geminicli-mcp -> .../dist/index.js). isEntryPoint() must
// follow that symlink, otherwise the server exits 0 without ever starting
// and the README's primary usage (`"command": "geminicli-mcp"`) is broken.
// Windows uses cmd shims that exec the real path, so this is POSIX-only.
test(
  "MCP stdio: server starts when launched through a bin-style symlink",
  { skip: process.platform === "win32" ? "npm uses cmd shims, not symlinks, on Windows" : false },
  async () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "geminicli-mcp-bin-"));
    const shimPath = path.join(binDir, "geminicli-mcp");
    fs.symlinkSync(serverPath, shimPath);

    const child = spawn("node", [shimPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      cwd: binDir, // not the repo root: the endsWith fallback must not be what saves us
    });

    const stderrChunks = [];
    child.stderr.on("data", (c) => stderrChunks.push(c));

    try {
      const initMsg = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-symlink-test", version: "1.0.0" },
        },
      });
      child.stdin.write(initMsg + "\n");

      const initResp = await readResponse(child);
      assert.equal(initResp.id, 1, "initialize response id should match request");
      assert.ok(initResp.result, "initialize should return a result");
      assert.equal(initResp.result.serverInfo.name, "geminicli-mcp");
    } finally {
      child.kill();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }
);
