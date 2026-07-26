// Offline tests for gemini_prompt_structured: schema validator, JSON
// extraction, and the structured-output parse/validate pipeline.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseAndValidateStructured,
  composeStructuredPrompt,
  invokeGeminiStructured,
} from "../dist/invoke.js";
import {
  validate,
  extractJson,
  validateSchemaDefinition,
} from "../dist/schema.js";
import { makeFakeBin, withEnv } from "./helpers.mjs";

const fakeOkResult = (text) => ({
  text,
  exitCode: 0,
  errorKind: "ok",
  raw: text,
});

// --- schema.ts validator ---------------------------------------------------

test("validate: type checking happy paths", () => {
  assert.deepEqual(validate(42, { type: "number" }), []);
  assert.deepEqual(validate(42, { type: "integer" }), []);
  assert.deepEqual(validate("x", { type: "string" }), []);
  assert.deepEqual(validate(true, { type: "boolean" }), []);
  assert.deepEqual(validate(null, { type: "null" }), []);
  assert.deepEqual(validate([1, 2], { type: "array" }), []);
  assert.deepEqual(validate({}, { type: "object" }), []);
});

test("validate: type mismatch is reported", () => {
  const errs = validate("hello", { type: "number" });
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /expected type number/);
});

test("validate: integer rejects non-integers", () => {
  const errs = validate(1.5, { type: "integer" });
  assert.equal(errs.length, 1);
});

test("validate: object required + properties", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"],
  };
  assert.deepEqual(validate({ name: "x", age: 7 }, schema), []);
  const missing = validate({ name: "x" }, schema);
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /missing required property 'age'/);
  const wrongType = validate({ name: 1, age: 7 }, schema);
  assert.equal(wrongType.length, 1);
  assert.match(wrongType[0].path, /\$\.name/);
});

test("validate: additionalProperties=false rejects extras", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "string" } },
    additionalProperties: false,
  };
  const errs = validate({ x: "ok", y: 1 }, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /unexpected additional property 'y'/);
});

test("validate: array items + minItems", () => {
  const schema = { type: "array", items: { type: "string" }, minItems: 2 };
  assert.equal(validate(["a", "b"], schema).length, 0);
  const bad = validate(["a"], schema);
  assert.match(bad[0].message, /minItems/);
  const wrongItem = validate(["a", 7], schema);
  assert.match(wrongItem[0].path, /\$\[1\]/);
});

test("validate: null array items validate against nullable item schemas (review finding 2)", () => {
  // Regression: `item ?? undefined` rewrote null items to undefined, so
  // {"items": {"type": ["string", "null"]}} rejected [null].
  const schema = { type: "array", items: { type: ["string", "null"] } };
  assert.deepEqual(validate([null, "a", null], schema), []);
  // enum/const item schemas that allow null must accept null items too.
  assert.deepEqual(
    validate([null], { type: "array", items: { enum: [null, "x"] } }),
    []
  );
  assert.deepEqual(
    validate([null], { type: "array", items: { const: null } }),
    []
  );
  // Genuine item-type violations are still reported at the right path.
  const errs = validate([null, 7], schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].path, /\$\[1\]/);
  assert.match(errs[0].message, /expected type string\|null/);
});

test("validate: caps error accumulation for a large invalid response", () => {
  const value = Array.from({ length: 10_000 }, () => 7);
  const errors = validate(value, {
    type: "array",
    items: { type: "string" },
  });
  assert.equal(errors.length, 100);
  assert.match(errors[0].path, /\$\[0\]/);
  assert.match(errors.at(-1).path, /\$\[99\]/);
});

test("validate: deeply nested const equality does not recurse on the JS stack", () => {
  let value = "leaf";
  for (let i = 0; i < 2_000; i++) value = { child: value };
  assert.deepEqual(validate(value, { const: value }), []);
});

test("validate: enum", () => {
  const schema = { enum: ["red", "green", "blue"] };
  assert.equal(validate("red", schema).length, 0);
  assert.equal(validate("yellow", schema).length, 1);
});

test("validate: anyOf", () => {
  const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
  assert.equal(validate("x", schema).length, 0);
  assert.equal(validate(7, schema).length, 0);
  const errs = validate(true, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /did not match any anyOf/);
});

// --- pattern / ReDoS protection (AUDIT-SEC-002 regression) ----------------

test("validate: ordinary pattern keyword still works for safe patterns", () => {
  const schema = { type: "string", pattern: "^[a-z]+$" };
  assert.equal(validate("hello", schema).length, 0);
  const errs = validate("Hello!", schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /does not match pattern/);
});

test("validate: pathological pattern (a+)+ is rejected before evaluation (AUDIT-SEC-002)", () => {
  const schema = { type: "string", pattern: "(a+)+" };
  const errs = validate("hello", schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /potentially unsafe.*pattern|ReDoS/i);
});

test("validate: nested quantifier pattern (a*)* is rejected (AUDIT-SEC-002)", () => {
  const schema = { type: "string", pattern: "(a*)*" };
  const errs = validate("hello", schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /potentially unsafe.*pattern|ReDoS/i);
});

test("validate: alternation with quantifier (a|b)+ is accepted as safe", () => {
  // Alternation inside quantifier is not a nested quantifier pattern
  const schema = { type: "string", pattern: "^(a|b)+$" };
  assert.equal(validate("abba", schema).length, 0);
});

test("validate: ambiguous repeated alternation (a|aa)+ is rejected", () => {
  // This shape is exponential on a long run of "a" followed by a mismatch,
  // despite containing no visibly nested quantifier.
  const schema = { type: "string", pattern: "^(a|aa)+$" };
  const errs = validate("hello", schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /potentially unsafe.*pattern|ReDoS/i);
});

test("validate: a repeated group with an earlier inner quantifier is rejected", () => {
  // The previous state machine only remembered whether the final atom in the
  // group was quantified, so it missed shapes such as (a+bc)+.
  const schema = { type: "string", pattern: "^(a+bc)+$" };
  const errs = validate("hello", schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /potentially unsafe.*pattern|ReDoS/i);
});

test("validate: wrapper groups cannot hide nested quantifier or alternation risks", () => {
  for (const pattern of [
    "^((a+))+$",
    "^(?:(?:a+))+$",
    "^(((a|aa)))+$",
  ]) {
    const errs = validate("hello", { type: "string", pattern });
    assert.equal(errs.length, 1, pattern);
    assert.match(errs[0].message, /potentially unsafe.*pattern|ReDoS/i);
  }
});

test("validate: unanchored repetition is rejected before polynomial backtracking", () => {
  // On a long non-match, /a+z/ retries the repeated atom at every input
  // position and exhibits quadratic runtime.
  const schema = { type: "string", pattern: "a+z" };
  const errs = validate("hello", schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /unanchored repetition|ReDoS/i);
  assert.ok(validateSchemaDefinition(schema).length > 0);
});

test("validate: adjacent overlapping quantified atoms are rejected", () => {
  // Anchoring alone does not make /^a+a+z$/ safe: the two repeated atoms can
  // partition the same run in quadratically many ways.
  for (const pattern of [
    "^a+a+z$",
    "^\\d+\\d+z$",
    "^[ab]+[bc]+z$",
    "^(?:ab)+(?:ab)+z$",
  ]) {
    const schema = { type: "string", pattern };
    const errs = validate("hello", schema);
    assert.equal(errs.length, 1, pattern);
    assert.match(errs[0].message, /adjacent overlapping|ReDoS/i);
    assert.ok(validateSchemaDefinition(schema).length > 0);
  }

  // Obviously disjoint adjacent atoms remain available.
  assert.equal(
    validate("abc123", {
      type: "string",
      pattern: "^[a-z]+[0-9]+$",
    }).length,
    0
  );
});

test("validate: deeply nested quantifier (a+)+b is rejected (AUDIT-SEC-002)", () => {
  const schema = { type: "string", pattern: "(a+)+b" };
  const errs = validate("hello", schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /potentially unsafe.*pattern|ReDoS/i);
});

test("validate: non-string value skips pattern check entirely", () => {
  const schema = { pattern: "(a+)+" };
  // When the value is not a string, pattern check is skipped;
  // only the type mismatch is reported (no ReDoS error).
  const errs = validate(42, schema);
  assert.equal(errs.length, 0); // no type constraint => no error
});

test("validate: optional-suffix pattern (X+)? is accepted as safe (review finding 3)", () => {
  // Regression: `?` after a quantified group runs the group at most once and
  // cannot backtrack catastrophically, but it used to be flagged as ReDoS.
  const decimal = { type: "string", pattern: "^\\d+(\\.\\d+)?$" };
  assert.equal(validate("1.25", decimal).length, 0);
  assert.equal(validate("7", decimal).length, 0);
  const errs = validate("not-a-number", decimal);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /does not match pattern/);
});

test("validate: semver-ish optional suffix pattern is accepted as safe (review finding 3)", () => {
  const schema = { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+(-[a-z]+)?$" };
  assert.equal(validate("1.2.3-beta", schema).length, 0);
  assert.equal(validate("1.2.3", schema).length, 0);
  assert.equal(validate("1.2", schema).length, 1);
});

test("validate: brace bounds after a quantified group are inspected (review finding 3)", () => {
  // Max <= 1: group runs at most once — safe.
  assert.equal(validate("aa", { type: "string", pattern: "^(a+){0,1}$" }).length, 0);
  // Unbounded {2,}: repetition allowed — still rejected.
  const unbounded = validate("hello", { type: "string", pattern: "(a+){2,}" });
  assert.equal(unbounded.length, 1);
  assert.match(unbounded[0].message, /ReDoS/i);
  // Bounded max > 1: still rejected (conservative).
  const bounded = validate("hello", { type: "string", pattern: "(a+){2,3}" });
  assert.equal(bounded.length, 1);
  assert.match(bounded[0].message, /ReDoS/i);
});

test("validate: optional group nested inside a repeated group is still rejected (review finding 3)", () => {
  // ((a+)?)+ is (a*)*-shaped — the outer + repeats — must stay flagged.
  const errs = validate("hello", { type: "string", pattern: "((a+)?)+" });
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /ReDoS/i);
});

test("validate: very long pattern is rejected", () => {
  const longPattern = "a".repeat(2048);
  const schema = { type: "string", pattern: longPattern };
  const errs = validate("hello", schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /potentially unsafe.*pattern|too long/i);
});

test("validate: bounds regex input length and aggregate evaluation work", () => {
  const oversized = validate("a".repeat(64 * 1024 + 1), {
    type: "string",
    pattern: "^a+$",
  });
  assert.equal(oversized.length, 1);
  assert.match(oversized[0].message, /too long for safe pattern evaluation/i);

  const repeatedChecks = validate("a".repeat(32 * 1024), {
    allOf: Array.from({ length: 9 }, () => ({
      type: "string",
      pattern: "^a+$",
    })),
  });
  assert.equal(repeatedChecks.length, 1);
  assert.match(repeatedChecks[0].message, /pattern evaluation budget exceeded/i);
});

test("validateSchemaDefinition rejects malformed nested schema shapes", () => {
  for (const schema of [
    { properties: { broken: 1 } },
    { items: [] },
    { allOf: [null] },
    { required: ["name", 7] },
    { minItems: -1 },
    { type: "not-a-json-type" },
  ]) {
    assert.ok(
      validateSchemaDefinition(schema).length > 0,
      `expected malformed schema to be rejected: ${JSON.stringify(schema)}`
    );
  }
});

test("validateSchemaDefinition bounds schema recursion before validate() can overflow", () => {
  let schema = { type: "string" };
  for (let i = 0; i < 70; i++) {
    schema = { allOf: [schema] };
  }
  const errors = validateSchemaDefinition(schema);
  assert.ok(errors.length > 0);
  assert.match(errors[0].message, /depth|nesting/i);
});

test("validateSchemaDefinition accepts a representative supported schema", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, pattern: "^[A-Za-z ]+$" },
      scores: {
        type: "array",
        items: { type: "number", minimum: 0, maximum: 100 },
      },
    },
    required: ["name"],
    additionalProperties: false,
  };
  assert.deepEqual(validateSchemaDefinition(schema), []);
});

// --- Additional schema keyword coverage (AUDIT-TEST-007, VAL-REM-F14-003) ---

test("validate: const keyword matches exact value (VAL-REM-F14-003)", () => {
  assert.deepEqual(validate(42, { const: 42 }), []);
  assert.deepEqual(validate("hello", { const: "hello" }), []);
  assert.deepEqual(validate(null, { const: null }), []);
  const errs = validate(7, { const: 42 });
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /expected const/);
});

test("validate: oneOf requires exactly one matching schema (VAL-REM-F14-003)", () => {
  const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
  // Exactly one match is valid.
  assert.equal(validate("x", schema).length, 0);
  assert.equal(validate(7, schema).length, 0);
  // No matches.
  const noMatch = validate(true, schema);
  assert.equal(noMatch.length, 1);
  assert.match(noMatch[0].message, /matched 0 oneOf/);
  // Both match (e.g. oneOf with overlapping schemas).
  const overlap = validate("x", { oneOf: [{ type: "string" }, { minLength: 1 }] });
  assert.equal(overlap.length, 1);
  assert.match(overlap[0].message, /matched 2 oneOf/);
});

test("validate: allOf requires all schemas to match (VAL-REM-F14-003)", () => {
  const schema = {
    allOf: [
      { type: "object", required: ["name"] },
      { type: "object", required: ["age"] },
    ],
  };
  assert.equal(validate({ name: "x", age: 7 }, schema).length, 0);
  const errs = validate({ name: "x" }, schema);
  assert.ok(errs.length >= 1, "should report at least one missing property");
  assert.ok(errs.some((e) => /missing required property 'age'/.test(e.message)));
});

test("validate: minLength and maxLength constrain string length (VAL-REM-F14-003)", () => {
  const schema = { type: "string", minLength: 2, maxLength: 5 };
  assert.equal(validate("abc", schema).length, 0);
  const tooShort = validate("a", schema);
  assert.equal(tooShort.length, 1);
  assert.match(tooShort[0].message, /minLength/);
  const tooLong = validate("abcdef", schema);
  assert.equal(tooLong.length, 1);
  assert.match(tooLong[0].message, /maxLength/);
});

test("validate: minimum and maximum constrain number range (VAL-REM-F14-003)", () => {
  const schema = { type: "number", minimum: 0, maximum: 100 };
  assert.equal(validate(50, schema).length, 0);
  assert.equal(validate(0, schema).length, 0);
  assert.equal(validate(100, schema).length, 0);
  const tooLow = validate(-1, schema);
  assert.equal(tooLow.length, 1);
  assert.match(tooLow[0].message, /minimum/);
  const tooHigh = validate(101, schema);
  assert.equal(tooHigh.length, 1);
  assert.match(tooHigh[0].message, /maximum/);
});

test("validate: maxItems constrains array length (VAL-REM-F14-003)", () => {
  const schema = { type: "array", maxItems: 2 };
  assert.equal(validate([1], schema).length, 0);
  assert.equal(validate([1, 2], schema).length, 0);
  const errs = validate([1, 2, 3], schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /maxItems/);
});

test("validate: additionalProperties as schema validates extra keys (VAL-REM-F14-003)", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    additionalProperties: { type: "number" },
  };
  // Extra property matches the additionalProperties schema.
  assert.equal(validate({ name: "x", extra: 7 }, schema).length, 0);
  // Extra property does NOT match the additionalProperties schema.
  const errs = validate({ name: "x", extra: "bad" }, schema);
  assert.ok(errs.length >= 1, "should reject extra property not matching schema");
  assert.ok(errs.some((e) => /\$\.extra/.test(e.path)));
});

test("validate: type as array accepts multiple types (VAL-REM-F14-003)", () => {
  const schema = { type: ["string", "null"] };
  assert.equal(validate("hello", schema).length, 0);
  assert.equal(validate(null, schema).length, 0);
  const errs = validate(42, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /expected type string\|null/);
});

// --- extractJson -----------------------------------------------------------

test("extractJson pulls a JSON object out of a fenced block", () => {
  const raw = 'Sure, here you go:\n```json\n{"a":1, "b":[1,2]}\n```';
  const out = extractJson(raw);
  assert.equal(out, '{"a":1, "b":[1,2]}');
});

test("extractJson handles raw object with surrounding prose", () => {
  const raw = 'preface\n{"a": 1, "b": "}{" }\ntrailing';
  const out = extractJson(raw);
  assert.equal(out, '{"a": 1, "b": "}{" }');
});

test("extractJson handles a bare array", () => {
  const raw = '[1, 2, 3]';
  assert.equal(extractJson(raw), '[1, 2, 3]');
});

test("extractJson returns undefined when there's no JSON", () => {
  assert.equal(extractJson("nope, no json here"), undefined);
});

test("extractJson: non-json fence tags fall through to the balanced scan (review finding 7)", () => {
  // ```js used to capture 'js\n{...}' — the language tag landed inside the
  // payload and broke JSON.parse even though the balanced scan would have
  // extracted the object cleanly.
  const raw = 'Sure:\n```js\n{"a":1}\n```';
  assert.equal(extractJson(raw), '{"a":1}');
});

test("extractJson: untagged and uppercase-tagged fences still extract (review finding 7)", () => {
  assert.equal(extractJson('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJson('```JSON\n{"a":1}\n```'), '{"a":1}');
  // One-line fence without a newline after the tag keeps working too.
  assert.equal(extractJson('```json {"a":1} ```'), '{"a":1}');
});

test("extractJson skips bracketed diagnostics before valid JSON", () => {
  assert.equal(
    extractJson('gemini [cached credentials]\n{"a":1}'),
    '{"a":1}'
  );
});

test("extractJson recovers valid JSON after unmatched diagnostic delimiters", () => {
  assert.equal(
    extractJson('warning { unclosed\n{"answer":42}'),
    '{"answer":42}'
  );
  assert.equal(extractJson("warning [ unclosed\n[1,2,3]"), "[1,2,3]");
  assert.equal(
    extractJson('warning {"partial":\n{"answer":42}'),
    '{"answer":42}'
  );
});

test("extractJson lets a valid value after an invalid JSON fence win", () => {
  assert.equal(
    extractJson('```json\nnot actually json\n```\n{"a":1}'),
    '{"a":1}'
  );
});

test("parseAndValidateStructured: js-fenced JSON parses via the balanced-scan fallback (review finding 7)", () => {
  const schema = {
    type: "object",
    properties: { x: { type: "number" } },
    required: ["x"],
  };
  const out = parseAndValidateStructured(
    fakeOkResult('```js\n{"x": 5}\n```'),
    schema
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.value, { x: 5 });
});

// --- parseAndValidateStructured -------------------------------------------

test("parseAndValidateStructured: success path returns value + canonical JSON", () => {
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  };
  const out = parseAndValidateStructured(
    fakeOkResult('{"ok": true}'),
    schema
  );
  assert.equal(out.exitCode, 0);
  assert.equal(out.errorKind, "ok");
  assert.deepEqual(out.value, { ok: true });
  assert.equal(out.text, '{"ok":true}');
});

test("parseAndValidateStructured: unwraps ```json fenced output", () => {
  const schema = { type: "object", properties: { x: { type: "number" } } };
  const out = parseAndValidateStructured(
    fakeOkResult('here:\n```json\n{"x": 5}\n```'),
    schema
  );
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.value, { x: 5 });
});

test("parseAndValidateStructured: fails loudly when the response isn't JSON", () => {
  const schema = { type: "object" };
  const out = parseAndValidateStructured(
    fakeOkResult("I refuse, no JSON for you"),
    schema
  );
  assert.equal(out.exitCode, 1);
  assert.equal(out.errorKind, "error");
  assert.match(out.text, /not valid JSON/);
  // The raw response must be preserved in the error so the caller can debug.
  assert.match(out.text, /I refuse/);
});

test("parseAndValidateStructured: fails loudly on schema mismatch", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  };
  const out = parseAndValidateStructured(
    fakeOkResult('{"oops": 1}'),
    schema
  );
  assert.equal(out.exitCode, 1);
  assert.equal(out.errorKind, "error");
  assert.match(out.text, /did not match schema/);
  assert.match(out.text, /missing required property 'name'/);
  // The received value must be echoed back so the caller can see what arrived.
  assert.match(out.text, /"oops": 1/);
});

test("parseAndValidateStructured: nested validation error reports the path", () => {
  const schema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      },
    },
  };
  const out = parseAndValidateStructured(
    fakeOkResult('{"items":[{"id":"a"},{}]}'),
    schema
  );
  assert.equal(out.exitCode, 1);
  assert.match(out.text, /\$\.items\[1\]/);
  assert.match(out.text, /missing required property 'id'/);
});

test("parseAndValidateStructured handles JSON deeper than JSON.stringify safely", () => {
  const depth = 10_000;
  const text = '{"child":'.repeat(depth) + "0" + "}".repeat(depth);
  const base = fakeOkResult(text);

  const accepted = parseAndValidateStructured(base, {});
  // V8's JSON.stringify depth limit varies by Node release. Older supported
  // runtimes must return a controlled error; runtimes with an iterative
  // serializer may legitimately accept and canonicalize the same value.
  if (accepted.exitCode === 0) {
    assert.equal(accepted.text, text);
  } else {
    assert.equal(accepted.exitCode, 1);
    assert.match(accepted.text, /could not be serialized safely/i);
  }

  const rejected = parseAndValidateStructured(base, { type: "string" });
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.text, /did not match schema/);
  assert.match(rejected.text, /--- received ---/);
});

// --- composeStructuredPrompt ----------------------------------------------

test("composeStructuredPrompt includes schema and an explicit JSON-only instruction", () => {
  const out = composeStructuredPrompt({
    prompt: "give me a person",
    schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  });
  assert.match(out, /give me a person/);
  assert.match(out, /Output ONLY the JSON value/);
  assert.match(out, /"required": \[\s*"name"\s*\]/);
});

test("composeStructuredPrompt wraps the context block when provided", () => {
  const out = composeStructuredPrompt({
    prompt: "p",
    context: "C",
    schema: { type: "object" },
  });
  assert.match(out, /<context>\nC\n<\/context>\n\np\n\nRespond/);
});

// --- invokeGeminiStructured: argument validation --------------------------

test("invokeGeminiStructured rejects a missing schema with input_validation", async () => {
  const out = await invokeGeminiStructured({
    prompt: "hi",
    // @ts-expect-error - intentionally bad
    schema: null,
  });
  assert.equal(out.exitCode, 42);
  assert.equal(out.errorKind, "input_validation");
});

test("invokeGeminiStructured rejects a malformed nested schema before spawning", async () => {
  const out = await invokeGeminiStructured({
    prompt: "hi",
    schema: { properties: { broken: 1 } },
  });
  assert.equal(out.exitCode, 42);
  assert.equal(out.errorKind, "input_validation");
  assert.match(out.text, /Invalid JSON Schema/);
});

test("invokeGeminiStructured surfaces ENOENT when the CLI is missing", async () => {
  await withEnv({ GEMINI_CLI_BIN: "/definitely/not/a/real/gemini-binary-xyz-456" }, async () => {
    const out = await invokeGeminiStructured({
      prompt: "hi",
      schema: { type: "object" },
    });
    assert.equal(out.exitCode, 127);
    assert.match(out.text, /Gemini CLI binary not found/);
  });
});

// --- invokeGeminiStructured: success path with fake CLI (AUDIT-TEST-003, VAL-REM-F13-003) ---

test("invokeGeminiStructured success path returns value field with validated JSON (VAL-REM-F13-003)", async () => {
  const fake = makeFakeBin(`printf '{"ok":true}'`);
  try {
    await withEnv({ GEMINI_CLI_BIN: fake }, async () => {
      const out = await invokeGeminiStructured({
        prompt: "give me JSON",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      });
      assert.equal(out.exitCode, 0);
      assert.equal(out.errorKind, "ok");
      assert.deepEqual(out.value, { ok: true });
      assert.equal(out.text, '{"ok":true}');
    });
  } finally {
    try { fs.unlinkSync(fake); } catch {}
  }
});
