/**
 * Shared test helpers: makeFakeBin and withEnv.
 *
 * Centralised here so individual test files avoid duplicating these
 * definitions (AUDIT-ARCH-001, AUDIT-ARCH-002, AUDIT-ARCH-006).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Write a tiny shell script to a temp file and chmod it executable.
 * Used as a drop-in GEMINI_CLI_BIN: the script ignores its argv (so
 * gemini-style flags don't confuse it) and just runs the body we hand it.
 *
 * @param {string} body - Shell script body (after #!/bin/sh).
 * @returns {string} Absolute path to the created temp script.
 */
export function makeFakeBin(body) {
  if (process.platform === "win32") {
    return makeFakeNodeBin(body);
  }

  const file = path.join(
    os.tmpdir(),
    `geminicli-mcp-fake-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.sh`
  );
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function makeFakeNodeBin(body) {
  const file = path.join(
    os.tmpdir(),
    `geminicli-mcp-fake-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.js`
  );
  fs.writeFileSync(file, nodeFakeBinSource(body), { mode: 0o755 });
  return file;
}

function nodeFakeBinSource(body) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const body = ${JSON.stringify(body)};

function writeStdout(text) {
  process.stdout.write(text);
}

function writeStderr(text) {
  process.stderr.write(text);
}

function loop(stream, text) {
  function pump() {
    while (stream.write(text)) {}
    stream.once("drain", pump);
  }
  pump();
}

function exitAfter(ms, code) {
  setTimeout(() => process.exit(code), ms);
}

if (body === "exit 1") {
  process.exit(1);
} else if (body === "exit 41") {
  process.exit(41);
} else if (body === "exec sleep 30") {
  setTimeout(() => {}, 30_000);
} else if (body === "while :; do printf 'y\\\\n'; done") {
  loop(process.stdout, "y\\n");
} else if (body === "while :; do printf 'err\\\\n' >&2; done") {
  loop(process.stderr, "err\\n");
} else if (body === "(sleep 3; kill $$ 2>/dev/null) & while :; do printf 'y\\\\n'; done") {
  exitAfter(3_000, 143);
  loop(process.stdout, "y\\n");
} else if (body === "printf 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'; sleep 1; exit 143") {
  writeStdout("yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy");
  exitAfter(1_000, 143);
} else if (body === "node -e 'setTimeout(()=>{},50); process.kill(process.pid,\\"SIGKILL\\")'") {
  setTimeout(() => {}, 50);
  process.kill(process.pid, "SIGKILL");
} else if (body === "printf '{\\"response\\":\\"chunked '; printf 'hello '; printf 'world\\"}'") {
  writeStdout('{"response":"chunked ');
  writeStdout("hello ");
  writeStdout('world"}');
} else if (body === "printf '{\\"response\\":\\"h\\\\303'; sleep 0.08; printf '\\\\251llo\\"}'") {
  const buf = Buffer.from("7b22726573706f6e7365223a2268c3a96c6c6f227d", "hex");
  process.stdout.write(buf.subarray(0, 15));
  setTimeout(() => process.stdout.write(buf.subarray(15)), 80);
} else if (body === 'node -e \\'process.stdout.write(JSON.stringify({response:"x".repeat(256)}))\\'') {
  writeStdout(JSON.stringify({ response: "x".repeat(256) }));
} else if (body.startsWith("printf ")) {
  if (!body.startsWith("printf '") || !body.endsWith("'")) {
    throw new Error("Unsupported fake printf body: " + body);
  }
  writeStdout(body.slice(8, -1).replace(/\\\\n/g, "\\n"));
} else if (body === "echo \\"auth bonk: please run gemini once\\" >&2; exit 41") {
  writeStderr("auth bonk: please run gemini once\\n");
  process.exit(41);
} else if (body.startsWith("echo \\"warning: something minor\\" >&2; printf ")) {
  writeStderr("warning: something minor\\n");
  writeStdout('{"response":"hello"}');
} else if (body.includes("writeFileSync") && body.includes("process.argv.slice(1)")) {
  const pathMatch = body.match(/writeFileSync\\((".*?"), JSON\\.stringify/);
  if (!pathMatch) throw new Error("Unsupported argv-capture body: " + body);
  fs.writeFileSync(JSON.parse(pathMatch[1]), JSON.stringify(process.argv.slice(2)));
  if (body.includes("printf '{\\"response\\":\\"ok\\"}'")) {
    writeStdout('{"response":"ok"}');
  }
} else if (body.includes(".split(\\"\\").forEach(c => process.stdout.write(c))")) {
  const jsonMatch = body.match(/node -e '(".*?")\\.split/);
  if (!jsonMatch) throw new Error("Unsupported chunked-output body: " + body);
  for (const c of JSON.parse(jsonMatch[1])) writeStdout(c);
} else if (body.includes("Buffer.from('") && body.includes("subarray(0, ")) {
  // Split-write body: emits a hex-encoded buffer in two chunks with a delay,
  // cutting a multibyte UTF-8 sequence in half (review finding 4).
  const hexMatch = body.match(/Buffer\\.from\\('([0-9a-fA-F]+)', 'hex'\\)/);
  const splitMatch = body.match(/subarray\\(0, (\\d+)\\)/);
  if (!hexMatch || !splitMatch) {
    throw new Error("Unsupported split-write body: " + body);
  }
  const buf = Buffer.from(hexMatch[1], "hex");
  const at = Number(splitMatch[1]);
  process.stdout.write(buf.subarray(0, at));
  setTimeout(() => process.stdout.write(buf.subarray(at)), 80);
} else {
  throw new Error("Unsupported fake bin body on Windows: " + body);
}
`;
}

/**
 * Temporarily set environment variables, restoring originals after the
 * callback completes (even on error). Replaces repeated inline
 * `const prev = process.env.X; process.env.X = val; try { … } finally { … }`
 * save/restore patterns across test files (AUDIT-ARCH-006).
 *
 * @param {Record<string, string | undefined>} overrides
 *   Keys to override. Use `undefined` as the value to delete a key.
 * @param {() => Promise<T>} fn - Async callback to run with the overridden env.
 * @returns {Promise<T>}
 * @template T
 */
export async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const val = overrides[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}
