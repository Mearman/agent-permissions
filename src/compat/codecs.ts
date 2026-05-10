/**
 * Agent compatibility codecs — bidirectional transforms between our canonical
 * `.agents/permissions.json` format and each agent's native permission config.
 *
 * Usage:
 *   decode: agent native config → canonical AgentPermissionPolicy
 *   encode: canonical AgentPermissionPolicy → agent native config
 *
 *   import { claudeCodeCodec } from "./compat/codecs.js";
 *
 *   // Read Claude Code settings and convert to canonical
 *   const canonical = claudeCodeCodec.decode(claudeSettings.permissions);
 *
 *   // Write canonical policy back out as Claude Code settings
 *   const claudePermBlock = z.encode(claudeCodeCodec, canonical);
 */

import * as z from "zod";
import {
  agentPermissionPolicy,
  type AgentPermissionPolicy,
} from "../schema.ts";

// ---------------------------------------------------------------------------
// Canonical agent identifiers
// ---------------------------------------------------------------------------

export const agentId = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "crush",
]);

export type AgentId = z.infer<typeof agentId>;

// ---------------------------------------------------------------------------
// Claude Code codec
// ---------------------------------------------------------------------------
// Claude Code uses `Tool(pattern)` rule strings in allow/deny/ask arrays.
// Our spec is a compatible superset — same rule syntax, same tiers.
// Conversion is mostly structural: our top-level defaultMode maps to/from
// their permissions.defaultMode (which we also accept inside permissions).

const claudeCodeNative = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    defaultMode: z
      .enum([
        "acceptEdits",
        "bypassPermissions",
        "default",
        "dontAsk",
        "plan",
      ])
      .optional(),
    additionalDirectories: z.array(z.string()).optional(),
  })
  .partial()
  .strict();

export const claudeCodeCodec = z.codec(claudeCodeNative, agentPermissionPolicy, {
  decode(native) {
    const result: Record<string, unknown> = {};

    if (native.allow ?? native.deny ?? native.ask ?? native.additionalDirectories) {
      result.permissions = {};
      if (native.allow) result.permissions.allow = native.allow;
      if (native.deny) result.permissions.deny = native.deny;
      if (native.ask) result.permissions.ask = native.ask;
      if (native.additionalDirectories)
        result.permissions.additionalDirectories = native.additionalDirectories;
    }

    if (native.defaultMode) result.defaultMode = native.defaultMode;

    return result as AgentPermissionPolicy;
  },
  encode(canonical) {
    const result: Record<string, unknown> = {};

    const perms = canonical.permissions;
    if (perms) {
      if (perms.allow) result.allow = perms.allow;
      if (perms.deny) result.deny = perms.deny;
      if (perms.ask) result.ask = perms.ask;
      if (perms.additionalDirectories)
        result.additionalDirectories = perms.additionalDirectories;
      // defaultMode inside permissions — Claude Code's native placement
      if (perms.defaultMode) result.defaultMode = perms.defaultMode;
    }

    // Also pick up top-level defaultMode
    if (canonical.defaultMode && !result.defaultMode)
      result.defaultMode = canonical.defaultMode;

    return result as z.infer<typeof claudeCodeNative>;
  },
});

// ---------------------------------------------------------------------------
// OpenCode codec
// ---------------------------------------------------------------------------
// OpenCode uses `{ tool: { pattern: "action" } }` with last-match-wins.
// Pattern syntax differs: space-separated (`"git *"`) vs our `:*` prefix.
// Tool names differ: lowercase (`edit`, `list`) vs our PascalCase (`Edit`, `Glob`).

const ocAction = z.enum(["ask", "allow", "deny"]);

const ocRule = z.union([ocAction, z.record(z.string(), ocAction)]);

const opencodeNative = z.union([
  ocAction,
  z
    .object({
      read: ocRule.optional(),
      edit: ocRule.optional(),
      glob: ocRule.optional(),
      grep: ocRule.optional(),
      list: ocRule.optional(),
      bash: ocRule.optional(),
      task: ocRule.optional(),
      external_directory: ocRule.optional(),
      todowrite: ocRule.optional(),
      question: ocRule.optional(),
      webfetch: ocRule.optional(),
      websearch: ocRule.optional(),
      codesearch: ocRule.optional(),
      repo_clone: ocRule.optional(),
      repo_overview: ocRule.optional(),
      lsp: ocRule.optional(),
      doom_loop: ocRule.optional(),
      skill: ocRule.optional(),
    })
    .strict(),
]);

/**
 * Map OpenCode tool names to our canonical names.
 * OpenCode uses lowercase; we use PascalCase.
 */
const ocToCanonical: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  list: "Glob", // list ≈ Glob
  webfetch: "WebFetch",
  websearch: "WebFetch", // websearch ≈ WebFetch
  task: "Agent", // subagent spawning ≈ Agent
};

/**
 * Map canonical tool names back to OpenCode tool names.
 * Each canonical tool maps to the primary OpenCode equivalent.
 */
const canonicalToOc: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Write: "edit", // write → edit in OpenCode
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  Agent: "task",
};

/**
 * Convert an OpenCode glob pattern to canonical rule syntax.
 * OpenCode: "git status *" (space-separated)
 * Canonical: "Bash(git status *)" (wrapped in parens)
 */
function ocPatternToCanonical(
  tool: string,
  pattern: string,
): string {
  const canonicalTool = ocToCanonical[tool] ?? tool;
  return `${canonicalTool}(${pattern})`;
}

/**
 * Convert a canonical rule string to OpenCode pattern syntax.
 * Canonical: "Bash(git status *)"
 * OpenCode tool: "bash", pattern: "git status *"
 */
function canonicalToOcPattern(
  rule: string,
): { tool: string; pattern: string } | undefined {
  // Bare tool name: "Read"
  const parenIdx = rule.indexOf("(");
  if (parenIdx === -1) {
    const ocTool = canonicalToOc[rule];
    if (!ocTool) return undefined;
    return { tool: ocTool, pattern: "*" };
  }

  // Tool(pattern)
  const canonicalTool = rule.slice(0, parenIdx);
  const ocTool = canonicalToOc[canonicalTool];
  if (!ocTool) return undefined;

  // Strip closing paren, handle :* prefix → space *
  let pattern = rule.slice(parenIdx + 1, -1);
  // Convert legacy :* prefix to wildcard: "git:*" → "git *"
  pattern = pattern.replace(/:\*$/, " *");

  return { tool: ocTool, pattern };
}

export const opencodeCodec = z.codec(opencodeNative, agentPermissionPolicy, {
  decode(native) {
    // Shorthand "allow"/"deny" applies to everything
    if (typeof native === "string") {
      return { defaultMode: native === "allow" ? "autonomous" : native === "deny" ? "restricted" : "standard" } as AgentPermissionPolicy;
    }

    const result: Record<string, unknown> = { permissions: {} };
    const perms = result.permissions as Record<string, unknown[]>;
    perms.allow = [];
    perms.deny = [];
    perms.ask = [];

    for (const [ocTool, rule] of Object.entries(native)) {
      if (rule === undefined) continue;
      if (ocTool === "external_directory") {
        // Map to additionalDirectories — we can't express path-level
        // allow/deny per tool, so we just note the external dirs.
        if (typeof rule === "object" && rule !== null) {
          const dirs = Object.keys(rule as Record<string, unknown>);
          (result.permissions as Record<string, unknown>).additionalDirectories = dirs;
        }
        continue;
      }
      if (ocTool === "doom_loop" || ocTool === "lsp" || ocTool === "skill" || ocTool === "question" || ocTool === "todowrite") {
        // No canonical equivalent — skip
        continue;
      }

      if (typeof rule === "string") {
        // Shorthand action for entire tool
        const canonicalRule = ocToCanonical[ocTool] ?? ocTool;
        if (rule === "allow") perms.allow.push(canonicalRule);
        else if (rule === "deny") perms.deny.push(canonicalRule);
        else if (rule === "ask") perms.ask.push(canonicalRule);
      } else if (typeof rule === "object" && rule !== null) {
        // Granular patterns: { "git *": "allow", "rm *": "deny" }
        for (const [pattern, action] of Object.entries(
          rule as Record<string, string>,
        )) {
          const canonicalRule = ocPatternToCanonical(ocTool, pattern);
          if (action === "allow") perms.allow.push(canonicalRule);
          else if (action === "deny") perms.deny.push(canonicalRule);
          else if (action === "ask") perms.ask.push(canonicalRule);
        }
      }
    }

    // Clean up empty arrays
    if (perms.allow.length === 0) delete perms.allow;
    if (perms.deny.length === 0) delete perms.deny;
    if (perms.ask.length === 0) delete perms.ask;

    return result as AgentPermissionPolicy;
  },
  encode(canonical) {
    const result: Record<string, Record<string, string>> = {};
    const perms = canonical.permissions;

    if (!perms) return { bash: "ask" } as z.infer<typeof opencodeNative>;

    const allRules = [
      ...(perms.allow?.map((r) => ({ rule: r, action: "allow" as const })) ?? []),
      ...(perms.deny?.map((r) => ({ rule: r, action: "deny" as const })) ?? []),
      ...(perms.ask?.map((r) => ({ rule: r, action: "ask" as const })) ?? []),
    ];

    for (const { rule, action } of allRules) {
      const parsed = canonicalToOcPattern(rule);
      if (!parsed) continue;

      if (!result[parsed.tool]) result[parsed.tool] = {};
      result[parsed.tool][parsed.pattern] = action;
    }

    // If any tool has only a single "*" pattern, simplify to shorthand
    for (const [tool, patterns] of Object.entries(result)) {
      const keys = Object.keys(patterns);
      if (keys.length === 1 && keys[0] === "*") {
        (result as Record<string, unknown>)[tool] = patterns["*"];
      }
    }

    return result as unknown as z.infer<typeof opencodeNative>;
  },
});

// ---------------------------------------------------------------------------
// Crush codec
// ---------------------------------------------------------------------------
// Crush has a simple allowlist: `permissions.allowed_tools: string[]`.
// No deny, no ask, no patterns. Tool names are lowercase.

const crushNative = z
  .object({
    allowed_tools: z.array(z.string()),
  })
  .strict();

/**
 * Map Crush tool names to canonical names.
 */
const crushToCanonical: Record<string, string> = {
  view: "Read",
  ls: "Glob",
  grep: "Grep",
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  fetch: "WebFetch",
  glob: "Glob",
  diagnostics: "Read", // ~read-only
  sourcegraph: "Grep", // ~search
  agent: "Agent",
};

const canonicalToCrush: Record<string, string> = {
  Read: "view",
  Glob: "ls",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  Bash: "bash",
  WebFetch: "fetch",
  Agent: "agent",
};

export const crushCodec = z.codec(crushNative, agentPermissionPolicy, {
  decode(native) {
    const allow: string[] = [];
    for (const tool of native.allowed_tools) {
      // MCP tools pass through as-is (mcp_server_tool format)
      const canonical = crushToCanonical[tool] ?? tool;
      allow.push(canonical);
    }
    return { permissions: { allow } } as AgentPermissionPolicy;
  },
  encode(canonical) {
    const allowed: string[] = [];
    for (const rule of canonical.permissions?.allow ?? []) {
      // Bare tool names only — Crush has no pattern syntax
      if (rule.includes("(")) continue;
      const crushTool = canonicalToCrush[rule];
      if (crushTool) allowed.push(crushTool);
    }
    return { allowed_tools: allowed };
  },
});

// ---------------------------------------------------------------------------
// Codec registry
// ---------------------------------------------------------------------------

export const CODECS = {
  "claude-code": claudeCodeCodec,
  opencode: opencodeCodec,
  crush: crushCodec,
} as const;

export type Codecs = typeof CODECS;
