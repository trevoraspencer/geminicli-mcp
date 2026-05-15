#!/usr/bin/env node
/**
 * geminicli-mcp — stdio MCP server wrapping the headless Gemini CLI.
 *
 * Stateless: no session_id, no --resume, no working_dir parameter.
 * Spawn-per-client: one server process per harness instance.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  invokeGemini,
  invokeGeminiStructured,
  type GeminiResult,
  type InvokeOptions,
} from "./invoke.js";
import type { JsonSchema } from "./schema.js";

/**
 * Read the package version from the root package.json so there is a single
 * source of truth. At runtime the compiled file lives in dist/, so
 * package.json is one directory up. Falls back to "0.0.0" if unreadable.
 */
const PACKAGE_VERSION: string = (() => {
  try {
    const here = path.resolve(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(path.dirname(here), "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const server = new Server(
  {
    name: "geminicli-mcp",
    version: PACKAGE_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

export const GEMINI_TOOL = {
  name: "gemini_prompt",
  description:
    "Invoke the headless Gemini CLI with a single prompt. Stateless — each call is an independent turn. Runs in the MCP server's current working directory.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Prompt text sent to the Gemini CLI.",
      },
      model: {
        type: "string",
        description: "Optional model identifier (e.g., gemini-2.5-pro).",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
} as const;

export const GEMINI_TOOL_WITH_CONTEXT = {
  name: "gemini_prompt_with_context",
  description:
    "Invoke the headless Gemini CLI with a prompt plus a separate context block. Stateless — each call is an independent turn. The context is prepended to the prompt inside a <context> tag. Runs in the MCP server's current working directory.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Prompt text sent to the Gemini CLI.",
      },
      context: {
        type: "string",
        description:
          "Context block prepended to the prompt (e.g., file contents, prior notes).",
      },
      model: {
        type: "string",
        description: "Optional model identifier (e.g., gemini-2.5-pro).",
      },
    },
    required: ["prompt", "context"],
    additionalProperties: false,
  },
} as const;

export const GEMINI_TOOL_STRUCTURED = {
  name: "gemini_prompt_structured",
  description:
    "Invoke the headless Gemini CLI and parse its response as JSON validated against a caller-provided JSON Schema. Stateless. Fails loudly with an isError result if the response is not valid JSON or does not match the schema.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Prompt text sent to the Gemini CLI.",
      },
      schema: {
        type: "object",
        description:
          "JSON Schema (subset) the model's JSON response must conform to.",
      },
      context: {
        type: "string",
        description:
          "Optional context block prepended to the prompt inside <context>.",
      },
      model: {
        type: "string",
        description: "Optional model identifier (e.g., gemini-2.5-pro).",
      },
    },
    required: ["prompt", "schema"],
    additionalProperties: false,
  },
} as const;

interface ToolArgs {
  prompt?: unknown;
  model?: unknown;
  context?: unknown;
  schema?: unknown;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function toMcpResult(result: GeminiResult) {
  let text =
    result.exitCode === 0
      ? result.text
      : `[${result.errorKind ?? "unknown"} exit=${result.exitCode}] ${result.text}`;

  // Append stderr to non-zero result text when stderr is non-empty.
  if (result.exitCode !== 0 && result.stderr) {
    text += `\n--- stderr ---\n${result.stderr}`;
  }
  // Surface truncation and abort metadata for MCP clients.
  if (result.truncated) text += "\n[truncated]";
  if (result.aborted) text += "\n[aborted]";

  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    isError: result.exitCode !== 0,
  };
}

/**
 * Validate tool arguments. Throws on missing required fields or wrong types.
 * Exported so tests can exercise the validation surface without spawning the CLI.
 */
export function validateToolArgs(
  toolName: string,
  args: ToolArgs
):
  | { kind: "prompt"; prompt: string; model?: string }
  | { kind: "context"; prompt: string; context: string; model?: string }
  | {
      kind: "structured";
      prompt: string;
      schema: JsonSchema;
      context?: string;
      model?: string;
    } {
  if (typeof args.prompt !== "string") {
    throw new Error("`prompt` must be a string");
  }
  if (args.prompt.length === 0) {
    throw new Error("`prompt` must be a non-empty string");
  }
  if (args.model !== undefined && typeof args.model !== "string") {
    throw new Error("`model` must be a string when provided");
  }
  const model =
    typeof args.model === "string" && args.model.length > 0
      ? args.model
      : undefined;
  if (model !== undefined && !MODEL_RE.test(model)) {
    // Prevent argv flag injection — `--model <value>` is spliced as a separate
    // argv element, but if <value> starts with `-` the gemini CLI's parser
    // will treat it as another flag.
    throw new Error(
      "`model` must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ (model ID like 'gemini-2.5-pro')"
    );
  }

  if (toolName === GEMINI_TOOL.name) {
    return {
      kind: "prompt" as const,
      prompt: args.prompt,
      ...(model ? { model } : {}),
    };
  }
  if (toolName === GEMINI_TOOL_WITH_CONTEXT.name) {
    if (typeof args.context !== "string") {
      throw new Error("`context` must be a string");
    }
    return {
      kind: "context" as const,
      prompt: args.prompt,
      context: args.context,
      ...(model ? { model } : {}),
    };
  }
  if (toolName === GEMINI_TOOL_STRUCTURED.name) {
    if (
      args.schema === undefined ||
      args.schema === null ||
      typeof args.schema !== "object" ||
      Array.isArray(args.schema)
    ) {
      throw new Error("`schema` must be a JSON Schema object");
    }
    if (args.context !== undefined && typeof args.context !== "string") {
      throw new Error("`context` must be a string when provided");
    }
    return {
      kind: "structured" as const,
      prompt: args.prompt,
      schema: args.schema as JsonSchema,
      ...(typeof args.context === "string" ? { context: args.context } : {}),
      ...(model ? { model } : {}),
    };
  }
  throw new Error(`Unknown tool: ${toolName}`);
}

/** Union of the three const-asserted MCP tool definition types. */
type ToolDefinition =
  | typeof GEMINI_TOOL
  | typeof GEMINI_TOOL_WITH_CONTEXT
  | typeof GEMINI_TOOL_STRUCTURED;

/**
 * Pure handler for ListTools. Exported so tests can exercise it without
 * connecting an MCP transport.
 */
export function handleListTools(): { tools: ToolDefinition[] } {
  return {
    tools: [GEMINI_TOOL, GEMINI_TOOL_WITH_CONTEXT, GEMINI_TOOL_STRUCTURED],
  };
}

/**
 * Pure handler for CallTool. Exported so tests can drive the full flow
 * (validation → invoke → MCP-shaped result) in-process. The `signal` is the
 * MCP request's per-call AbortSignal — forwarding it kills the gemini child
 * if the caller cancels.
 */
export async function handleCallTool(
  req: { params: { name: string; arguments?: unknown } },
  extra?: { signal?: AbortSignal }
): Promise<CallToolResult> {
  const args = (req.params.arguments ?? {}) as ToolArgs;
  const parsed = validateToolArgs(req.params.name, args);
  const options: InvokeOptions = extra?.signal
    ? { signal: extra.signal }
    : {};

  if (parsed.kind === "prompt") {
    return toMcpResult(
      await invokeGemini(
        { prompt: parsed.prompt, ...("model" in parsed ? { model: parsed.model } : {}) },
        options
      )
    );
  }
  if (parsed.kind === "context") {
    return toMcpResult(
      await invokeGemini(
        {
          prompt: parsed.prompt,
          context: parsed.context,
          ...("model" in parsed ? { model: parsed.model } : {}),
        },
        options
      )
    );
  }
  // structured
  return toMcpResult(
    await invokeGeminiStructured(
      {
        prompt: parsed.prompt,
        schema: parsed.schema,
        ...("context" in parsed ? { context: parsed.context } : {}),
        ...("model" in parsed ? { model: parsed.model } : {}),
      },
      options
    )
  );
}

server.setRequestHandler(ListToolsRequestSchema, async () => handleListTools());

server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
  handleCallTool(req, extra)
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only auto-start when invoked as the entry point; importing the module (e.g.
// from tests) must NOT spawn the stdio transport. We resolve both ends of the
// comparison to absolute paths so symlinks, Windows path quirks, and
// relative-argv launches still work.
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const here = path.resolve(fileURLToPath(import.meta.url));
    const launched = path.resolve(argv1);
    if (here === launched) return true;
  } catch {
    // fall through to the endsWith fallback
  }
  return argv1.endsWith(`dist${path.sep}index.js`) || argv1.endsWith("dist/index.js");
}

const invokedDirectly = isEntryPoint();

if (invokedDirectly) {
  main().catch((err) => {
    console.error("geminicli-mcp fatal:", err);
    process.exit(1);
  });
}
