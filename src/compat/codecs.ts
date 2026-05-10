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
// Codex (OpenAI) codec
// ---------------------------------------------------------------------------
// Codex uses OS-level sandboxing + an approval_policy field, not rule strings.
// TOML serialisation is a file-I/O concern, not the codec's job.
// The codec works on the JS object that any TOML parser produces.
//
// Key concepts:
//   approval_policy: "untrusted" | "on-request" | "never" | { granular: {...} }
//   sandbox_mode: "read-only" | "workspace-write" | "danger-full-access"
//   permissions: named profiles with filesystem + network rules
//   default_permissions: name of the active profile
//
// Mapping:
//   approval_policy ↔ defaultMode
//   sandbox_mode "read-only" → defaultMode "readonly"
//   sandbox_mode "danger-full-access" → defaultMode "autonomous"
//   permissions.filesystem → deny/allow rules with Read/Write/Edit patterns
//   permissions.network.domains → WebFetch allow/deny rules

const codexApprovalPolicy = z.union([
  z.enum(["untrusted", "on-failure", "on-request", "never"]),
  z.object({
    granular: z.object({
      sandbox_approval: z.boolean(),
      rules: z.boolean(),
      mcp_elicitations: z.boolean(),
      request_permissions: z.boolean().optional(),
      skill_approval: z.boolean().optional(),
    }),
  }),
]);

const codexSandboxMode = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const codexFilesystemAccess = z.enum(["read", "write", "none"]);

/**
 * Codex native config object — what a TOML parser produces from codex config.
 * Only the permission-relevant fields; the full schema has 60+ keys.
 */
const codexNative = z.object({
  approval_policy: codexApprovalPolicy.optional(),
  sandbox_mode: codexSandboxMode.optional(),
  default_permissions: z.string().optional(),
  sandbox_workspace_write: z
    .object({
      writable_roots: z.array(z.string()).optional(),
      network_access: z.boolean().optional(),
    })
    .partial()
    .optional(),
  // Named permission profiles: { [name]: { filesystem: { ... }, network: { ... } } }
  // PermissionsToml is typed as `{}` in the schema — free-form object
  permissions: z
    .record(
      z.string(),
      z.object({
        filesystem: z
          .union([
            // Shorthand: apply single mode to entire workspace
            codexFilesystemAccess,
            // Granular: { "/path": "read" | "write" | "none" }
            z.record(z.string(), codexFilesystemAccess),
          ])
          .optional(),
        network: z
          .object({
            enabled: z.boolean().optional(),
            domains: z
              .record(z.string(), z.enum(["allow", "deny"]))
              .optional(),
          })
          .partial()
          .optional(),
      }),
    )
    .optional(),
});

/**
 * Map Codex approval_policy to canonical defaultMode.
 */
function codexApprovalToMode(
  policy: z.infer<typeof codexApprovalPolicy>,
): AgentPermissionPolicy["defaultMode"] {
  if (typeof policy === "string") {
    switch (policy) {
      case "untrusted": return "restricted";
      case "on-request": return "standard";
      case "on-failure": return "standard";
      case "never": return "autonomous";
    }
  }
  // Granular — treat as standard (some ops auto-approved, some ask)
  return "standard";
}

/**
 * Map canonical defaultMode back to Codex approval_policy.
 */
function modeToCodexApproval(
  mode: AgentPermissionPolicy["defaultMode"],
  sandbox?: string,
): z.infer<typeof codexApprovalPolicy> {
  // Sandbox modes constrain what approval_policy means:
  // read-only + autonomous → "never" (sandbox already prevents writes)
  // danger-full-access + autonomous → "never" (explicit opt-in)
  if (mode === "autonomous" || mode === "bypassPermissions" || mode === "dontAsk") {
    return "never";
  }
  if (mode === "restricted" || mode === "plan" || mode === "readonly") {
    return "untrusted";
  }
  // standard, acceptEdits, default
  return "on-request";
}

/**
 * Map Codex filesystem access mode to canonical deny/allow rules.
 * Codex paths are absolute; we convert to relative where possible.
 */
function codexFilesystemToRules(
  fs: z.infer<typeof codexFilesystemAccess> | Record<string, z.infer<typeof codexFilesystemAccess>>,
  allow: string[],
  deny: string[],
): void {
  if (typeof fs === "string") {
    // Shorthand — applies to entire workspace
    if (fs === "read") {
      deny.push("Write", "Edit");
    } else if (fs === "none") {
      deny.push("Read", "Write", "Edit");
    }
    // "write" is the default — no restrictions
    return;
  }

  // Granular: { "/path": "read" | "write" | "none" }
  for (const [path, mode] of Object.entries(fs)) {
    const rulePath = path.startsWith("/") ? `.${path}` : path;
    if (mode === "none") {
      deny.push(`Read(${rulePath})`, `Write(${rulePath})`, `Edit(${rulePath})`);
    } else if (mode === "read") {
      deny.push(`Write(${rulePath})`, `Edit(${rulePath})`);
    }
    // "write" — no restriction
  }
}

export const codexCodec = z.codec(codexNative, agentPermissionPolicy, {
  decode(native) {
    const result: Record<string, unknown> = {};
    const perms: Record<string, unknown[]> = { allow: [], deny: [] };

    // --- approval_policy → defaultMode ---
    if (native.approval_policy) {
      result.defaultMode = codexApprovalToMode(native.approval_policy);
    }

    // --- sandbox_mode → defaultMode override ---
    if (native.sandbox_mode === "read-only") {
      result.defaultMode = "readonly";
      perms.deny.push("Write", "Edit");
    } else if (native.sandbox_mode === "danger-full-access") {
      // If no explicit approval_policy, upgrade to autonomous
      if (!native.approval_policy) result.defaultMode = "autonomous";
    }

    // --- sandbox_workspace_write.writable_roots → additionalDirectories ---
    if (native.sandbox_workspace_write?.writable_roots) {
      perms.additionalDirectories = native.sandbox_workspace_write.writable_roots;
    }

    // --- Named permission profiles ---
    // Use default_permissions if set, otherwise use all profiles
    const profiles = native.permissions ?? {};
    const activeProfile = native.default_permissions
      ? { [native.default_permissions]: profiles[native.default_permissions] }
      : profiles;

    for (const [, profile] of Object.entries(activeProfile)) {
      if (profile.filesystem) {
        codexFilesystemToRules(profile.filesystem, perms.allow, perms.deny);
      }
      if (profile.network?.domains) {
        for (const [domain, action] of Object.entries(profile.network.domains)) {
          if (action === "allow") perms.allow.push(`WebFetch(domain:${domain})`);
          else if (action === "deny") perms.deny.push(`WebFetch(domain:${domain})`);
        }
      }
    }

    // Clean up empty arrays
    if (perms.allow.length > 0 || perms.deny.length > 0 || perms.additionalDirectories) {
      result.permissions = {};
      if (perms.allow.length > 0) result.permissions.allow = perms.allow;
      if (perms.deny.length > 0) result.permissions.deny = perms.deny;
      if (perms.additionalDirectories) result.permissions.additionalDirectories = perms.additionalDirectories;
    }

    return result as AgentPermissionPolicy;
  },
  encode(canonical) {
    const result: Record<string, unknown> = {};
    const perms = canonical.permissions;

    // --- defaultMode → approval_policy + sandbox_mode ---
    if (canonical.defaultMode) {
      result.approval_policy = modeToCodexApproval(canonical.defaultMode);

      if (canonical.defaultMode === "readonly") {
        result.sandbox_mode = "read-only";
      } else if (
        canonical.defaultMode === "autonomous" ||
        canonical.defaultMode === "bypassPermissions"
      ) {
        result.sandbox_mode = "danger-full-access";
      } else {
        result.sandbox_mode = "workspace-write";
      }
    }

    // --- additionalDirectories → writable_roots ---
    if (perms?.additionalDirectories?.length) {
      result.sandbox_workspace_write = {
        writable_roots: perms.additionalDirectories,
      };
    }

    // --- deny/allow rules → Codex named profile ---
    if (perms?.deny?.length || perms?.allow?.length) {
      const filesystem: Record<string, string> = {};
      const domains: Record<string, string> = {};

      for (const rule of perms?.deny ?? []) {
        // Parse Read/W Edit/W at path → filesystem none/read
        const parsed = parseToolPathPattern(rule);
        if (parsed) {
          const mode = (parsed.tool === "Read") ? "read" : "none";
          // Codex uses "write" as the baseline, so we only add restrictions
          const existing = filesystem[parsed.path];
          // "none" beats "read" (more restrictive)
          if (!existing || (existing === "read" && mode === "none")) {
            filesystem[parsed.path] = mode;
          }
          continue;
        }

        // WebFetch(domain:X) → network.domains
        const domainMatch = rule.match(/^WebFetch\(domain:(.+)\)$/);
        if (domainMatch) {
          domains[domainMatch[1]] = "deny";
        }
      }

      for (const rule of perms?.allow ?? []) {
        const domainMatch = rule.match(/^WebFetch\(domain:(.+)\)$/);
        if (domainMatch) {
          domains[domainMatch[1]] = "allow";
        }
      }

      // Build the named profile
      const profile: Record<string, unknown> = {};
      if (Object.keys(filesystem).length > 0) {
        // Convert relative paths back to absolute for Codex
        const absoluteFs: Record<string, string> = {};
        for (const [path, mode] of Object.entries(filesystem)) {
          absoluteFs[path.startsWith(".") ? path.slice(1) : path] = mode;
        }
        profile.filesystem = absoluteFs;
      }
      if (Object.keys(domains).length > 0) {
        profile.network = { domains };
      }

      if (Object.keys(profile).length > 0) {
        result.permissions = { default: profile };
        result.default_permissions = "default";
      }
    }

    return result as z.infer<typeof codexNative>;
  },
});

/**
 * Parse a canonical tool-path pattern like `Read(./src/**)` or `Write(./config)`.
 * Returns the tool name and path, or undefined if not a file-path rule.
 */
function parseToolPathPattern(
  rule: string,
): { tool: string; path: string } | undefined {
  const match = rule.match(/^(Read|Write|Edit)\((.+)\)$/);
  if (!match) return undefined;
  return { tool: match[1], path: match[2] };
}

// ---------------------------------------------------------------------------
// Codec registry
// ---------------------------------------------------------------------------

export const CODECS = {
  "claude-code": claudeCodeCodec,
  codex: codexCodec,
  opencode: opencodeCodec,
  crush: crushCodec,
} as const;

export type Codecs = typeof CODECS;
