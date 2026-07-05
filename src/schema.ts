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
 * that happen to look complex, but it will never allow a truly pathological
 * nested-quantifier pattern through. Ordinary patterns used in JSON Schema
 * (emails, dates, identifiers, and optional-suffix idioms like
 * `^\d+(\.\d+)?$`) are unaffected: a quantified group followed by `?` runs
 * at most once and is not treated as a nested quantifier.
 */

/** Maximum allowed pattern string length. */
const MAX_PATTERN_LENGTH = 1024;

/**
 * Detect nested quantifier ReDoS patterns.
 *
 * Walks the pattern looking for groups whose contents end with a quantifier
 * (`+`, `*`, or `{n,m}`) and where the group itself is followed by a
 * quantifier that permits repetition (`+`, `*`, `{n,}`, or `{n,m}` with
 * max > 1). This catches `(a+)+`, `(x*)+`, `((a|b)+)*`, `(a+){2,}`, etc.
 * while leaving the group-runs-at-most-once forms `(a+)?` / `(a+){0,1}`
 * alone.
 *
 * The approach is a simple state machine rather than a full regex parser:
 * it tracks group nesting depth and whether the last atom inside a group
 * had a quantifier, then checks if the closing parenthesis is itself
 * quantified.
 */
function hasNestedQuantifiers(pattern: string): boolean {
  let i = 0;
  const len = pattern.length;

  // Track whether the last atom at each nesting depth carried a quantifier.
  // depthStack[d] is true when the group at depth d contained a quantified atom.
  const depthStack: boolean[] = [];
  let lastAtomQuantified = false;

  while (i < len) {
    const ch = pattern[i];

    if (ch === "(") {
      // Non-capturing groups (?: ... ), lookaheads (?= ... ), etc. still nest.
      depthStack.push(lastAtomQuantified);
      lastAtomQuantified = false;
      // Skip the ?: or ?= or ?! modifier if present
      if (i + 1 < len && pattern[i + 1] === "?") {
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (ch === ")") {
      if (depthStack.length === 0) {
        // Unbalanced — let RegExp constructor handle the error.
        return false;
      }
      const groupHadQuantifier = lastAtomQuantified;
      lastAtomQuantified = depthStack.pop() ?? false;
      // Check if the closing group itself is followed by a quantifier that
      // permits repetition. A `?` (or a `{...}` bound with max <= 1) runs the
      // group at most once and cannot cause catastrophic backtracking, so the
      // very common optional-suffix idiom `(X+)?` stays usable.
      if (
        groupHadQuantifier &&
        i + 1 < len &&
        quantifierAllowsRepetition(pattern, i + 1)
      ) {
        return true; // Nested quantifier detected.
      }
      i++;
      continue;
    }

    if (ch === "[") {
      // Character class: skip to closing ].
      lastAtomQuantified = false;
      i++;
      if (i < len && pattern[i] === "^") i++; // negated class
      while (i < len && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++; // skip escaped char
        i++;
      }
      // The character class itself is an atom; check quantifier.
      if (i < len) i++; // skip ]
      if (i < len && isQuantifier(pattern, i)) {
        lastAtomQuantified = true;
        i = skipQuantifier(pattern, i);
      } else {
        lastAtomQuantified = false;
      }
      continue;
    }

    if (ch === "\\") {
      // Escaped character — skip it and any following digits/hex.
      lastAtomQuantified = false;
      i++; // skip the backslash
      if (i < len) {
        // Handle \xHH, \uHHHH, etc. — just skip one more char for simplicity.
        i++;
      }
      // The escaped sequence is an atom; check quantifier.
      if (i < len && isQuantifier(pattern, i)) {
        lastAtomQuantified = true;
        i = skipQuantifier(pattern, i);
      } else {
        lastAtomQuantified = false;
      }
      continue;
    }

    // Quantifiers applied to the previous atom are handled at the atom site.
    // Anchors (^, $), pipes (|), and dots (.) are atoms.
    if (isQuantifier(pattern, i)) {
      // This is a quantifier for the previous atom — it was already handled
      // when we processed that atom. Skip it.
      i = skipQuantifier(pattern, i);
      lastAtomQuantified = true;
      continue;
    }

    // Ordinary atom (literal character, dot, anchor, pipe).
    lastAtomQuantified = false;
    i++;
    if (i < len && isQuantifier(pattern, i)) {
      lastAtomQuantified = true;
      i = skipQuantifier(pattern, i);
    }
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
  return undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (
        !deepEqual(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k]
        )
      )
        return false;
    }
    return true;
  }
  return false;
}

export function validate(
  value: unknown,
  schema: JsonSchema,
  path: string = "$"
): ValidationError[] {
  const errors: ValidationError[] = [];

  // type
  if ("type" in schema) {
    const t = schema.type;
    const types: string[] = Array.isArray(t) ? t : [t];
    const ok = types.some((tt) => matchesType(value, tt));
    if (!ok) {
      errors.push({
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
      errors.push({
        path,
        message: `expected const ${JSON.stringify(schema.const)}`,
      });
    }
  }

  // enum
  if ("enum" in schema && Array.isArray(schema.enum)) {
    const allowed = schema.enum;
    if (!allowed.some((opt) => deepEqual(opt, value))) {
      errors.push({
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
      errors.push({
        path,
        message: `string shorter than minLength ${schema.minLength}`,
      });
    }
    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      errors.push({
        path,
        message: `string longer than maxLength ${schema.maxLength}`,
      });
    }
    if (typeof schema.pattern === "string") {
      // Inline ReDoS protection (AUDIT-SEC-002): reject unsafe patterns
      // before they reach new RegExp(). See checkPatternSafety for details.
      const safetyError = checkPatternSafety(schema.pattern);
      if (safetyError) {
        errors.push({ path, message: safetyError });
      } else {
        let re: RegExp | undefined;
        try {
          re = new RegExp(schema.pattern);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          // Invalid regex is a caller-side schema bug, not a value bug. Report
          // it once and skip the pattern check rather than emitting a spurious
          // "does not match pattern" error on top.
          errors.push({
            path,
            message: `invalid regex in schema.pattern: ${detail}`,
          });
        }
        if (re && !re.test(value)) {
          errors.push({ path, message: `string does not match pattern` });
        }
      }
    }
  }

  // number keywords
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `value < minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `value > maximum ${schema.maximum}` });
    }
  }

  // array keywords
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push({
        path,
        message: `array shorter than minItems ${schema.minItems}`,
      });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push({
        path,
        message: `array longer than maxItems ${schema.maxItems}`,
      });
    }
    if (schema.items && typeof schema.items === "object") {
      const itemSchema = schema.items;
      for (let i = 0; i < value.length; i++) {
        // Pass items through untouched — rewriting null to undefined here
        // broke schemas like {"items": {"type": ["string", "null"]}}.
        errors.push(...validate(value[i], itemSchema, `${path}[${i}]`));
      }
    }
  }

  // object keywords
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const r of required) {
      if (!Object.prototype.hasOwnProperty.call(obj, r)) {
        errors.push({ path, message: `missing required property '${r}'` });
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        errors.push(...validate(obj[k], sub, `${path}.${k}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) {
          errors.push({
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
        if (!Object.prototype.hasOwnProperty.call(props, k)) {
          errors.push(...validate(obj[k], sub, `${path}.${k}`));
        }
      }
    }
  }

  // combinators
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      errors.push(...validate(value, sub, path));
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const subs = schema.anyOf;
    const matched = subs.some((sub) => validate(value, sub, path).length === 0);
    if (!matched) {
      errors.push({ path, message: `value did not match any anyOf schema` });
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const subs = schema.oneOf;
    const matches = subs.filter(
      (sub) => validate(value, sub, path).length === 0
    ).length;
    if (matches !== 1) {
      errors.push({
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
      return (fenceMatch[2] ?? "").trim();
    }
  }
  const firstObj = raw.indexOf("{");
  const firstArr = raw.indexOf("[");
  let start: number;
  let open: string;
  let close: string;
  if (firstObj === -1 && firstArr === -1) return undefined;
  if (firstObj === -1) {
    start = firstArr;
    open = "[";
    close = "]";
  } else if (firstArr === -1 || firstObj < firstArr) {
    start = firstObj;
    open = "{";
    close = "}";
  } else {
    start = firstArr;
    open = "[";
    close = "]";
  }
  let depth = 0;
  let inString = false;
  let escape = false;
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
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return undefined;
}
