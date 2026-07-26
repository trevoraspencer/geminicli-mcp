/**
 * schema.ts — tiny hand-rolled JSON-Schema-subset validator.
 *
 * Intentionally minimal: covers the surface a Gemini structured-output caller
 * is realistically going to ask for. Avoids pulling ajv (or any runtime dep)
 * for the v1.0.0 release.
 *
 * Supported keywords:
 *   - type: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null"
 *           (or an array of those)
 *   - enum: any[]
 *   - const: any
 *   - properties: { [k: string]: Schema }
 *   - required: string[]
 *   - additionalProperties: boolean | Schema (default true)
 *   - items: Schema (tuple form not supported)
 *   - minItems / maxItems: number
 *   - minLength / maxLength: number
 *   - minimum / maximum: number
 *   - pattern: string (RegExp)
 *   - anyOf / oneOf / allOf: Schema[]
 *
 * Returns a list of error strings — empty array == valid.
 */

export type JsonSchemaTypeName =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object"
  | "null";

export interface JsonSchema {
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
}

export interface ValidationError {
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type === "number") return typeof value === "number";
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return false;
}

/**
 * Inline ReDoS protection for schema.pattern (AUDIT-SEC-002).
 *
 * Rejects patterns that are too long or that contain nested quantifiers
 * (e.g. `(a+)+`, `(a*)*`) before they reach `new RegExp()`. No external
 * dependency is used — this is a lightweight heuristic sufficient for the
 * hand-rolled schema subset this module supports.
 *
 * The check is intentionally conservative: it may reject some safe patterns
 * that happen to look complex. It blocks the common nested-quantifier and
 * ambiguous-repeated-alternation families, unanchored repetition, and
 * adjacent overlapping repetition before evaluation. Ordinary anchored
 * patterns used in JSON Schema (emails, dates, identifiers, and optional
 * suffix idioms like `^\d+(\.\d+)?$`) are unaffected: a quantified group
 * followed by `?` runs at most once and is not treated as nested.
 */

/** Maximum allowed pattern string length. */
const MAX_PATTERN_LENGTH = 1024;

/**
 * Detect nested quantifier ReDoS patterns.
 *
 * Walks the pattern looking for repeated groups containing any inner
 * quantifier, or a non-trivial alternation. This catches `(a+)+`, `(x*)+`,
 * `(a+bc)+`, `(a|aa)+`, `((a|b)+)*`, `(a+){2,}`, etc. while leaving the
 * group-runs-at-most-once forms `(a+)?` / `(a+){0,1}` alone.
 *
 * The approach is a simple state machine rather than a full regex parser:
 * it tracks group nesting depth and whether any atom inside a group had a
 * quantifier, then checks if the closing parenthesis is itself quantified.
 */
function hasNestedQuantifiers(pattern: string): boolean {
  let i = 0;
  const len = pattern.length;
  let groupContainsQuantifier = false;
  let groupContainsUnsafeAlternation = false;

  const groups: Array<{
    parentContainsQuantifier: boolean;
    parentContainsUnsafeAlternation: boolean;
    contentStart: number;
  }> = [];

  const consumeAtomQuantifier = () => {
    if (i < len && isQuantifier(pattern, i)) {
      groupContainsQuantifier = true;
      i = skipQuantifier(pattern, i);
    }
  };

  while (i < len) {
    const ch = pattern[i];

    if (ch === "(") {
      groups.push({
        parentContainsQuantifier: groupContainsQuantifier,
        parentContainsUnsafeAlternation: groupContainsUnsafeAlternation,
        contentStart: i + 1,
      });
      groupContainsQuantifier = false;
      groupContainsUnsafeAlternation = false;
      i++;
      // Skip the prefix of non-capturing groups and common lookarounds. They
      // still participate in the same repetition analysis.
      if (pattern[i] === "?") {
        i++;
        if (pattern[i] === "<" && (pattern[i + 1] === "=" || pattern[i + 1] === "!")) {
          i += 2;
        } else if (i < len) {
          i++;
        }
        const current = groups[groups.length - 1];
        if (current) current.contentStart = i;
      }
      continue;
    }

    if (ch === ")") {
      const group = groups.pop();
      if (!group) {
        // Unbalanced — let RegExp construction report the syntax error.
        return false;
      }
      const repeated =
        i + 1 < len && quantifierAllowsRepetition(pattern, i + 1);
      const body = pattern.slice(group.contentStart, i);
      const containsQuantifier: boolean = groupContainsQuantifier;
      const containsUnsafeAlternation: boolean =
        groupContainsUnsafeAlternation || hasUnsafeRepeatedAlternation(body);
      if (
        repeated &&
        (containsQuantifier || containsUnsafeAlternation)
      ) {
        return true;
      }

      // Propagate hazards through otherwise-unquantified wrapper groups. For
      // example, `^((a+))+$` is just as vulnerable as `^(a+)+$`, and a parent
      // repeated later must be able to see the inner `a+`.
      groupContainsQuantifier =
        group.parentContainsQuantifier || containsQuantifier;
      groupContainsUnsafeAlternation =
        group.parentContainsUnsafeAlternation || containsUnsafeAlternation;
      i++;
      // The whole group is now an atom inside its parent. Even `?` counts as
      // an inner quantifier if the parent is itself repeated later.
      consumeAtomQuantifier();
      continue;
    }

    if (ch === "[") {
      // Character class: skip escaped characters until the closing bracket.
      i++;
      if (i < len && pattern[i] === "^") i++;
      while (i < len && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      if (i < len) i++;
      consumeAtomQuantifier();
      continue;
    }

    if (ch === "\\") {
      // Treat an escaped sequence as one atom. Exact escape parsing is left to
      // RegExp; this pass only needs to find the following quantifier.
      i = Math.min(len, i + 2);
      consumeAtomQuantifier();
      continue;
    }

    if (isQuantifier(pattern, i)) {
      // A malformed/lone quantifier is handled by RegExp construction.
      groupContainsQuantifier = true;
      i = skipQuantifier(pattern, i);
      continue;
    }

    i++;
    consumeAtomQuantifier();
  }

  return false;
}

/**
 * Repeated alternations can be exponential even without a visibly nested
 * quantifier: `^(a|aa)+$` is the canonical example. Accept only the trivially
 * disjoint single-literal form (such as `(a|b)+`) and reject other repeated
 * top-level alternations conservatively.
 */
function hasUnsafeRepeatedAlternation(body: string): boolean {
  const branches: string[] = [];
  let start = 0;
  let depth = 0;
  let inClass = false;
  let escaped = false;

  for (let index = 0; index < body.length; index++) {
    const ch = body[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "|" && depth === 0) {
      branches.push(body.slice(start, index));
      start = index + 1;
    }
  }
  if (branches.length === 0) return false;
  branches.push(body.slice(start));

  const literals = new Set<string>();
  for (const branch of branches) {
    const chars = [...branch];
    if (
      chars.length !== 1 ||
      /[\\.^$*+?()[\]{}|]/u.test(chars[0] ?? "") ||
      literals.has(branch)
    ) {
      return true;
    }
    literals.add(branch);
  }
  return false;
}

/**
 * Whether the quantifier starting at index `i` allows more than one
 * repetition of the preceding atom. `+`, `*`, and `{n,}` / `{n,m}` with
 * max > 1 do; `?` and brace bounds with max <= 1 (`{0,1}`, `{1}`) do not.
 * A `{` that is not valid quantifier syntax is a literal brace, i.e. not a
 * quantifier at all.
 */
function quantifierAllowsRepetition(pattern: string, i: number): boolean {
  const ch = pattern[i];
  if (ch === "+" || ch === "*") return true;
  if (ch === "?") return false;
  if (ch !== "{") return false;
  const close = pattern.indexOf("}", i + 1);
  if (close === -1) return false; // unterminated -> literal '{'
  const bounds = pattern.slice(i + 1, close);
  const m = /^(\d+)(?:,(\d*))?$/.exec(bounds);
  if (!m) return false; // not {n} / {n,} / {n,m} syntax -> literal '{'
  if (m[2] === undefined) return Number(m[1]) > 1; // {n}
  if (m[2] === "") return true; // {n,} — unbounded
  return Number(m[2]) > 1; // {n,m}
}

function isQuantifier(pattern: string, i: number): boolean {
  if (i >= pattern.length) return false;
  const ch = pattern[i];
  return ch === "+" || ch === "*" || ch === "?" || ch === "{";
}

function skipQuantifier(pattern: string, i: number): number {
  if (i >= pattern.length) return i;
  const ch = pattern[i];
  if (ch === "+" || ch === "*" || ch === "?") return i + 1;
  if (ch === "{") {
    // Skip {n}, {n,}, {n,m}.
    const close = pattern.indexOf("}", i + 1);
    return close === -1 ? pattern.length : close + 1;
  }
  return i;
}

/** Whether a pattern contains an unescaped quantifier that can repeat. */
function hasRepetitionQuantifier(pattern: string): boolean {
  let inClass = false;
  let escaped = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (quantifierAllowsRepetition(pattern, i)) return true;
  }
  return false;
}

function asciiRange(start: string, end: string): Set<string> | undefined {
  const first = start.codePointAt(0);
  const last = end.codePointAt(0);
  if (
    first === undefined ||
    last === undefined ||
    first > last ||
    last > 0x7f
  ) {
    return undefined;
  }
  const chars = new Set<string>();
  for (let code = first; code <= last; code++) {
    chars.add(String.fromCodePoint(code));
  }
  return chars;
}

function escapeAlphabet(escape: string): Set<string> | undefined {
  if (escape === "\\d") return asciiRange("0", "9");
  if (escape === "\\w") {
    return new Set([
      ...(asciiRange("0", "9") ?? []),
      ...(asciiRange("A", "Z") ?? []),
      "_",
      ...(asciiRange("a", "z") ?? []),
    ]);
  }
  if (escape === "\\s") return new Set([" ", "\t", "\n", "\r", "\f", "\v"]);
  if (/^\\[^dDsSwWpPkK0-9]$/u.test(escape)) {
    return new Set([escape[1] ?? ""]);
  }
  return undefined;
}

/** Compute an ASCII alphabet for a simple positive character class. */
function classAlphabet(source: string): Set<string> | undefined {
  const body = source.slice(1, -1);
  if (body.startsWith("^")) return undefined;
  const alphabet = new Set<string>();
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === undefined) return undefined;
    if (ch === "\\") {
      const escaped = body.slice(i, i + 2);
      const chars = escapeAlphabet(escaped);
      if (!chars) return undefined;
      for (const item of chars) alphabet.add(item);
      i++;
      continue;
    }
    if (body[i + 1] === "-" && i + 2 < body.length) {
      const chars = asciiRange(ch, body[i + 2] ?? "");
      if (!chars) return undefined;
      for (const item of chars) alphabet.add(item);
      i += 2;
      continue;
    }
    if ((ch.codePointAt(0) ?? 0x80) > 0x7f) return undefined;
    alphabet.add(ch);
  }
  return alphabet;
}

/**
 * Catch the common polynomial-backtracking form made from two adjacent,
 * overlapping repeated atoms: `a+a+`, `\d+\d*`, `[ab]+[bc]+`, or `.*.*`.
 *
 * This deliberately is not a full regular-expression parser; the broader
 * input/work budget below bounds patterns that evade the static checks.
 */
function hasAdjacentRepeatedAtoms(pattern: string): boolean {
  type Frame = {
    lastRepeated: boolean;
    /** undefined = no prior atom; null = an alphabet we cannot prove disjoint. */
    lastAlphabet: Set<string> | null | undefined;
    contentStart: number;
  };

  const frames: Frame[] = [
    { lastRepeated: false, lastAlphabet: undefined, contentStart: 0 },
  ];

  const recordAtom = (
    frame: Frame,
    alphabet: Set<string> | undefined,
    repeated: boolean
  ): boolean => {
    const currentAlphabet = alphabet ?? null;
    const previousAlphabet = frame.lastAlphabet;
    const overlaps =
      previousAlphabet === null ||
      currentAlphabet === null ||
      (previousAlphabet !== undefined &&
        [...previousAlphabet].some((char) => currentAlphabet.has(char)));
    if (repeated && frame.lastRepeated && overlaps) return true;
    frame.lastRepeated = repeated;
    frame.lastAlphabet = currentAlphabet;
    return false;
  };

  const consumeQuantifier = (
    atomEnd: number
  ): { next: number; repeated: boolean } => {
    if (!isQuantifier(pattern, atomEnd)) {
      return { next: atomEnd, repeated: false };
    }
    const repeated = quantifierAllowsRepetition(pattern, atomEnd);
    let next = skipQuantifier(pattern, atomEnd);
    // A trailing `?` makes a quantifier lazy; it does not change whether the
    // atom can repeat.
    if (pattern[next] === "?") next++;
    return { next, repeated };
  };

  let i = 0;
  while (i < pattern.length) {
    const frame = frames[frames.length - 1];
    if (!frame) return false;
    const ch = pattern[i];
    if (ch === undefined) return false;

    if (ch === "(") {
      let contentStart = i + 1;
      if (pattern[contentStart] === "?") {
        contentStart++;
        if (
          pattern[contentStart] === "<" &&
          (pattern[contentStart + 1] === "=" ||
            pattern[contentStart + 1] === "!")
        ) {
          contentStart += 2;
        } else if (contentStart < pattern.length) {
          contentStart++;
        }
      }
      frames.push({
        lastRepeated: false,
        lastAlphabet: undefined,
        contentStart,
      });
      i = contentStart;
      continue;
    }

    if (ch === ")" && frames.length > 1) {
      const group = frames.pop();
      const parent = frames[frames.length - 1];
      if (!group || !parent) return false;
      const quantified = consumeQuantifier(i + 1);
      if (recordAtom(parent, undefined, quantified.repeated)) return true;
      i = quantified.next;
      continue;
    }

    if (ch === "|") {
      // Adjacency never crosses alternatives.
      frame.lastRepeated = false;
      frame.lastAlphabet = undefined;
      i++;
      continue;
    }

    if (ch === "^" || ch === "$") {
      i++;
      continue;
    }

    if (ch === "[") {
      let end = i + 1;
      let escaped = false;
      while (end < pattern.length) {
        const current = pattern[end];
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === "]") {
          end++;
          break;
        }
        end++;
      }
      const quantified = consumeQuantifier(end);
      const alphabet = classAlphabet(pattern.slice(i, end));
      if (recordAtom(frame, alphabet, quantified.repeated)) return true;
      i = quantified.next;
      continue;
    }

    if (ch === "\\") {
      const end = Math.min(pattern.length, i + 2);
      const quantified = consumeQuantifier(end);
      const alphabet = escapeAlphabet(pattern.slice(i, end));
      if (recordAtom(frame, alphabet, quantified.repeated)) return true;
      i = quantified.next;
      continue;
    }

    if (isQuantifier(pattern, i)) {
      // Leave malformed standalone quantifiers to RegExp construction.
      frame.lastRepeated = false;
      frame.lastAlphabet = undefined;
      i = skipQuantifier(pattern, i);
      continue;
    }

    const quantified = consumeQuantifier(i + 1);
    const alphabet = ch === "." ? undefined : new Set([ch]);
    if (recordAtom(frame, alphabet, quantified.repeated)) return true;
    i = quantified.next;
  }

  return false;
}

/**
 * Check whether a regex pattern string is safe to compile.
 * Returns an error message if unsafe, or undefined if safe.
 */
function checkPatternSafety(pattern: string): string | undefined {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `schema.pattern too long (${pattern.length} chars, max ${MAX_PATTERN_LENGTH}) — potentially unsafe regex rejected`;
  }
  if (hasNestedQuantifiers(pattern)) {
    return `schema.pattern contains nested quantifiers (ReDoS risk) — potentially unsafe regex rejected`;
  }
  if (hasRepetitionQuantifier(pattern) && !pattern.startsWith("^")) {
    return `schema.pattern contains unanchored repetition (ReDoS risk) — potentially unsafe regex rejected`;
  }
  if (hasAdjacentRepeatedAtoms(pattern)) {
    return `schema.pattern contains adjacent overlapping quantifiers (ReDoS risk) — potentially unsafe regex rejected`;
  }
  return undefined;
}

const JSON_SCHEMA_TYPES = new Set<JsonSchemaTypeName>([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
]);
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_SCHEMA_ERRORS = 100;

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate the shape of the supported JSON Schema subset before it is added to
 * a prompt or used by the recursive value validator.
 *
 * MCP input is untrusted. Without this preflight, malformed shapes such as
 * `{properties: {x: 1}}` or `{allOf: [null]}` reach `validate()` and can throw
 * a TypeError. Depth/node/size bounds also keep a valid-but-hostile schema from
 * exhausting the server stack or producing an unexpectedly huge CLI argv.
 */
export function validateSchemaDefinition(value: unknown): ValidationError[] {
  if (!isSchemaObject(value)) {
    return [{ path: "$", message: "schema must be a JSON object" }];
  }

  let serialized: string;
  try {
    const result = JSON.stringify(value);
    if (result === undefined) {
      return [{ path: "$", message: "schema must be JSON-serializable" }];
    }
    serialized = result;
  } catch {
    return [
      {
        path: "$",
        message: "schema must be acyclic and JSON-serializable",
      },
    ];
  }
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > MAX_SCHEMA_BYTES) {
    return [
      {
        path: "$",
        message: `schema is too large (${serializedBytes} bytes, max ${MAX_SCHEMA_BYTES})`,
      },
    ];
  }

  const errors: ValidationError[] = [];
  const stack: Array<{
    schema: Record<string, unknown>;
    path: string;
    depth: number;
  }> = [{ schema: value, path: "$", depth: 0 }];
  let nodes = 0;

  const addError = (path: string, message: string) => {
    if (errors.length < MAX_SCHEMA_ERRORS) errors.push({ path, message });
  };
  const enqueue = (child: unknown, path: string, depth: number) => {
    if (!isSchemaObject(child)) {
      addError(path, "must be a schema object");
      return;
    }
    stack.push({ schema: child, path, depth });
  };

  while (stack.length > 0 && errors.length < MAX_SCHEMA_ERRORS) {
    const current = stack.pop();
    if (!current) break;
    const { schema, path, depth } = current;
    nodes++;
    if (nodes > MAX_SCHEMA_NODES) {
      addError(
        "$",
        `schema has too many nested schemas (max ${MAX_SCHEMA_NODES})`
      );
      break;
    }
    if (depth > MAX_SCHEMA_DEPTH) {
      addError(path, `schema nesting exceeds maximum depth ${MAX_SCHEMA_DEPTH}`);
      continue;
    }

    if ("type" in schema) {
      const typeValue = schema.type;
      const types = Array.isArray(typeValue) ? typeValue : [typeValue];
      if (types.length === 0) {
        addError(`${path}.type`, "must not be an empty array");
      }
      const seenTypes = new Set<string>();
      for (const typeName of types) {
        if (
          typeof typeName !== "string" ||
          !JSON_SCHEMA_TYPES.has(typeName as JsonSchemaTypeName)
        ) {
          addError(
            `${path}.type`,
            "must contain only supported JSON Schema type names"
          );
          continue;
        }
        if (seenTypes.has(typeName)) {
          addError(`${path}.type`, `contains duplicate type '${typeName}'`);
        }
        seenTypes.add(typeName);
      }
    }

    if ("enum" in schema) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
        addError(`${path}.enum`, "must be a non-empty array");
      }
    }

    if ("properties" in schema) {
      if (!isSchemaObject(schema.properties)) {
        addError(`${path}.properties`, "must be an object");
      } else {
        for (const [key, child] of Object.entries(schema.properties)) {
          enqueue(
            child,
            `${path}.properties[${JSON.stringify(key)}]`,
            depth + 1
          );
        }
      }
    }

    if ("required" in schema) {
      if (
        !Array.isArray(schema.required) ||
        !schema.required.every((entry) => typeof entry === "string")
      ) {
        addError(`${path}.required`, "must be an array of strings");
      } else if (new Set(schema.required).size !== schema.required.length) {
        addError(`${path}.required`, "must not contain duplicate names");
      }
    }

    if ("additionalProperties" in schema) {
      const additional = schema.additionalProperties;
      if (typeof additional !== "boolean") {
        enqueue(additional, `${path}.additionalProperties`, depth + 1);
      }
    }

    if ("items" in schema) {
      enqueue(schema.items, `${path}.items`, depth + 1);
    }

    for (const keyword of [
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
    ] as const) {
      if (
        keyword in schema &&
        (!Number.isSafeInteger(schema[keyword]) ||
          (schema[keyword] as number) < 0)
      ) {
        addError(`${path}.${keyword}`, "must be a non-negative integer");
      }
    }
    if (
      typeof schema.minItems === "number" &&
      typeof schema.maxItems === "number" &&
      schema.minItems > schema.maxItems
    ) {
      addError(path, "minItems must not exceed maxItems");
    }
    if (
      typeof schema.minLength === "number" &&
      typeof schema.maxLength === "number" &&
      schema.minLength > schema.maxLength
    ) {
      addError(path, "minLength must not exceed maxLength");
    }

    for (const keyword of ["minimum", "maximum"] as const) {
      if (
        keyword in schema &&
        (typeof schema[keyword] !== "number" ||
          !Number.isFinite(schema[keyword]))
      ) {
        addError(`${path}.${keyword}`, "must be a finite number");
      }
    }
    if (
      typeof schema.minimum === "number" &&
      typeof schema.maximum === "number" &&
      schema.minimum > schema.maximum
    ) {
      addError(path, "minimum must not exceed maximum");
    }

    if ("pattern" in schema) {
      if (typeof schema.pattern !== "string") {
        addError(`${path}.pattern`, "must be a string");
      } else {
        const safetyError = checkPatternSafety(schema.pattern);
        if (safetyError) addError(`${path}.pattern`, safetyError);
        else {
          try {
            new RegExp(schema.pattern);
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            addError(`${path}.pattern`, `invalid regular expression: ${detail}`);
          }
        }
      }
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      if (!(keyword in schema)) continue;
      const branches = schema[keyword];
      if (!Array.isArray(branches) || branches.length === 0) {
        addError(`${path}.${keyword}`, "must be a non-empty array of schemas");
        continue;
      }
      for (let index = 0; index < branches.length; index++) {
        enqueue(
          branches[index],
          `${path}.${keyword}[${index}]`,
          depth + 1
        );
      }
    }
  }

  return errors;
}

function deepEqual(a: unknown, b: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[a, b]];
  while (pending.length > 0) {
    const pair = pending.pop();
    if (!pair) break;
    const [left, right] = pair;
    if (left === right) continue;
    if (typeof left !== typeof right || left === null || right === null) {
      return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
      if (
        !Array.isArray(left) ||
        !Array.isArray(right) ||
        left.length !== right.length
      ) {
        return false;
      }
      for (let index = 0; index < left.length; index++) {
        pending.push([left[index], right[index]]);
      }
      continue;
    }
    if (typeof left === "object" && typeof right === "object") {
      const leftObject = left as Record<string, unknown>;
      const rightObject = right as Record<string, unknown>;
      const leftKeys = Object.keys(leftObject);
      const rightKeys = Object.keys(rightObject);
      if (leftKeys.length !== rightKeys.length) return false;
      for (const key of leftKeys) {
        if (!Object.prototype.hasOwnProperty.call(rightObject, key)) {
          return false;
        }
        pending.push([leftObject[key], rightObject[key]]);
      }
      continue;
    }
    return false;
  }
  return true;
}

const MAX_VALUE_VALIDATION_ERRORS = 100;
const MAX_PATTERN_INPUT_LENGTH = 64 * 1024;
const MAX_PATTERN_EVALUATION_CHARS = 256 * 1024;

interface ValidationContext {
  patternEvaluationChars: number;
}

function addValidationError(
  errors: ValidationError[],
  error: ValidationError
): void {
  if (errors.length < MAX_VALUE_VALIDATION_ERRORS) errors.push(error);
}

function appendValidationErrors(
  errors: ValidationError[],
  additional: ValidationError[]
): void {
  const remaining = MAX_VALUE_VALIDATION_ERRORS - errors.length;
  if (remaining > 0) errors.push(...additional.slice(0, remaining));
}

export function validate(
  value: unknown,
  schema: JsonSchema,
  path: string = "$"
): ValidationError[] {
  return validateValue(value, schema, path, { patternEvaluationChars: 0 });
}

function validateValue(
  value: unknown,
  schema: JsonSchema,
  path: string,
  context: ValidationContext
): ValidationError[] {
  const errors: ValidationError[] = [];

  // type
  if ("type" in schema) {
    const t = schema.type;
    const types: string[] = Array.isArray(t) ? t : [t];
    const ok = types.some((tt) => matchesType(value, tt));
    if (!ok) {
      addValidationError(errors, {
        path,
        message: `expected type ${types.join("|")} but got ${typeOf(value)}`,
      });
      // Type-driven keywords below are pointless on a type miss; bail.
      return errors;
    }
  }

  // const
  if ("const" in schema) {
    if (!deepEqual(value, schema.const)) {
      addValidationError(errors, {
        path,
        message: `expected const ${JSON.stringify(schema.const)}`,
      });
    }
  }

  // enum
  if ("enum" in schema && Array.isArray(schema.enum)) {
    const allowed = schema.enum;
    if (!allowed.some((opt) => deepEqual(opt, value))) {
      addValidationError(errors, {
        path,
        message: `value not in enum ${JSON.stringify(allowed)}`,
      });
    }
  }

  // string keywords
  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      addValidationError(errors, {
        path,
        message: `string shorter than minLength ${schema.minLength}`,
      });
    }
    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      addValidationError(errors, {
        path,
        message: `string longer than maxLength ${schema.maxLength}`,
      });
    }
    if (typeof schema.pattern === "string") {
      // Inline ReDoS protection (AUDIT-SEC-002): reject unsafe patterns
      // before they reach new RegExp(). See checkPatternSafety for details.
      const safetyError = checkPatternSafety(schema.pattern);
      if (safetyError) {
        addValidationError(errors, { path, message: safetyError });
      } else {
        let re: RegExp | undefined;
        try {
          re = new RegExp(schema.pattern);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          // Invalid regex is a caller-side schema bug, not a value bug. Report
          // it once and skip the pattern check rather than emitting a spurious
          // "does not match pattern" error on top.
          addValidationError(errors, {
            path,
            message: `invalid regex in schema.pattern: ${detail}`,
          });
        }
        if (re) {
          if (value.length > MAX_PATTERN_INPUT_LENGTH) {
            addValidationError(errors, {
              path,
              message:
                `string too long for safe pattern evaluation ` +
                `(${value.length} chars, max ${MAX_PATTERN_INPUT_LENGTH})`,
            });
          } else if (
            context.patternEvaluationChars + value.length >
            MAX_PATTERN_EVALUATION_CHARS
          ) {
            addValidationError(errors, {
              path,
              message:
                `pattern evaluation budget exceeded ` +
                `(max ${MAX_PATTERN_EVALUATION_CHARS} input chars)`,
            });
          } else {
            context.patternEvaluationChars += value.length;
            if (!re.test(value)) {
              addValidationError(errors, {
                path,
                message: `string does not match pattern`,
              });
            }
          }
        }
      }
    }
  }

  // number keywords
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      addValidationError(errors, {
        path,
        message: `value < minimum ${schema.minimum}`,
      });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      addValidationError(errors, {
        path,
        message: `value > maximum ${schema.maximum}`,
      });
    }
  }

  // array keywords
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      addValidationError(errors, {
        path,
        message: `array shorter than minItems ${schema.minItems}`,
      });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      addValidationError(errors, {
        path,
        message: `array longer than maxItems ${schema.maxItems}`,
      });
    }
    if (schema.items && typeof schema.items === "object") {
      const itemSchema = schema.items;
      for (let i = 0; i < value.length; i++) {
        if (errors.length >= MAX_VALUE_VALIDATION_ERRORS) break;
        // Pass items through untouched — rewriting null to undefined here
        // broke schemas like {"items": {"type": ["string", "null"]}}.
        appendValidationErrors(
          errors,
          validateValue(value[i], itemSchema, `${path}[${i}]`, context)
        );
      }
    }
  }

  // object keywords
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const r of required) {
      if (errors.length >= MAX_VALUE_VALIDATION_ERRORS) break;
      if (!Object.prototype.hasOwnProperty.call(obj, r)) {
        addValidationError(errors, {
          path,
          message: `missing required property '${r}'`,
        });
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (errors.length >= MAX_VALUE_VALIDATION_ERRORS) break;
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        appendValidationErrors(
          errors,
          validateValue(obj[k], sub, `${path}.${k}`, context)
        );
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (errors.length >= MAX_VALUE_VALIDATION_ERRORS) break;
        if (!Object.prototype.hasOwnProperty.call(props, k)) {
          addValidationError(errors, {
            path,
            message: `unexpected additional property '${k}'`,
          });
        }
      }
    } else if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      const sub = schema.additionalProperties;
      for (const k of Object.keys(obj)) {
        if (errors.length >= MAX_VALUE_VALIDATION_ERRORS) break;
        if (!Object.prototype.hasOwnProperty.call(props, k)) {
          appendValidationErrors(
            errors,
            validateValue(obj[k], sub, `${path}.${k}`, context)
          );
        }
      }
    }
  }

  // combinators
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      if (errors.length >= MAX_VALUE_VALIDATION_ERRORS) break;
      appendValidationErrors(errors, validateValue(value, sub, path, context));
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const subs = schema.anyOf;
    const matched = subs.some(
      (sub) => validateValue(value, sub, path, context).length === 0
    );
    if (!matched) {
      addValidationError(errors, {
        path,
        message: `value did not match any anyOf schema`,
      });
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const subs = schema.oneOf;
    const matches = subs.filter(
      (sub) => validateValue(value, sub, path, context).length === 0
    ).length;
    if (matches !== 1) {
      addValidationError(errors, {
        path,
        message: `value matched ${matches} oneOf schemas (expected exactly 1)`,
      });
    }
  }

  return errors;
}

export function formatErrors(errors: ValidationError[]): string {
  return errors.map((e) => `  - ${e.path}: ${e.message}`).join("\n");
}

/**
 * Extract the first balanced JSON object or array from a string.
 * Useful when a model wraps its JSON in prose or ```json fences.
 */
export function extractJson(raw: string): string | undefined {
  // Strip ```json ... ``` fences if present. The info string is captured
  // explicitly: with the old `(?:json)?` a non-JSON tag like ```js matched
  // empty and the tag landed inside the extracted payload, breaking
  // JSON.parse. Unrecognized tags now fall through to the balanced scan.
  const fenceMatch = raw.match(
    /```([A-Za-z0-9+#._-]*)[ \t]*\r?\n?([\s\S]*?)```/
  );
  if (fenceMatch) {
    const tag = (fenceMatch[1] ?? "").toLowerCase();
    if (tag === "" || tag === "json") {
      const fenced = (fenceMatch[2] ?? "").trim();
      try {
        JSON.parse(fenced);
        return fenced;
      } catch {
        // A mislabeled/invalid fence should not hide a later valid JSON value.
      }
    }
  }

  let cursor = 0;
  let deferredFallback: string | undefined;
  while (cursor < raw.length) {
    const nextObject = raw.indexOf("{", cursor);
    const nextArray = raw.indexOf("[", cursor);
    let start: number;
    if (nextObject === -1 && nextArray === -1) return deferredFallback;
    if (nextObject === -1) {
      start = nextArray;
    } else if (nextArray === -1 || nextObject < nextArray) {
      start = nextObject;
    } else {
      start = nextArray;
    }

    const stack: Array<{ open: "{" | "["; start: number }> = [];
    let inString = false;
    let escape = false;
    let end = -1;
    let nestedFallback: string | undefined;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{" || ch === "[") {
        stack.push({ open: ch, start: i });
        continue;
      }
      if (ch === "}" || ch === "]") {
        const current = stack[stack.length - 1];
        const expected = current?.open === "{" ? "}" : "]";
        if (!current || ch !== expected) {
          // A mismatched delimiter belongs to malformed prose. Keep scanning:
          // a later, properly balanced nested value can still be recovered as
          // a fallback if this outer candidate never becomes valid.
          continue;
        }
        stack.pop();
        if (stack.length === 0) {
          end = i;
          break;
        }
        if (nestedFallback === undefined) {
          const nested = raw.slice(current.start, i + 1);
          try {
            JSON.parse(nested);
            nestedFallback = nested;
          } catch {
            // Try a later nested value in this outer candidate.
          }
        }
      }
    }
    if (end === -1) return nestedFallback ?? deferredFallback;

    const candidate = raw.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Prose often contains bracketed diagnostics before the real JSON
      // (for example "[cached]"). Continue after that balanced candidate.
      // If malformed prose encloses a valid nested value, retain it only as a
      // last resort so a later top-level JSON response still wins.
      deferredFallback ??= nestedFallback;
      cursor = end + 1;
    }
  }
  return deferredFallback;
}
