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
  type PermissionTiers,
  type Sandbox,
} from "../schema.ts";
import {
  ClaudeCodePermissionMode,
  CodexApprovalMode,
  CodexDomainAccess,
  CodexFilesystemAccess,
  CodexSandboxMode,
  PermissionBehavior,
} from "./enums.ts";

// ---------------------------------------------------------------------------
// Canonical agent identifiers
// ---------------------------------------------------------------------------

export const agentId = z.enum(["claude-code", "codex", "opencode", "crush"]);

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
    defaultMode: ClaudeCodePermissionMode.optional(),
    additionalDirectories: z.array(z.string()).optional(),
  })
  .partial()
  .strict();

type ClaudeCodeNative = z.infer<typeof claudeCodeNative>;

export const claudeCodeCodec = z.codec(
  claudeCodeNative,
  agentPermissionPolicy,
  {
    decode(native) {
      const result: Partial<AgentPermissionPolicy> = {};

      if (
        native.allow ??
        native.deny ??
        native.ask ??
        native.additionalDirectories
      ) {
        const perms: Partial<PermissionTiers> = {};
        if (native.allow) perms.allow = native.allow;
        if (native.deny) perms.deny = native.deny;
        if (native.ask) perms.ask = native.ask;
        if (native.additionalDirectories)
          perms.additionalDirectories = native.additionalDirectories;
        result.permissions = perms;
      }

      if (native.defaultMode) {
        // Claude Code's defaultMode is a narrower enum; it's already a valid canonical mode
        result.defaultMode = native.defaultMode;
      }

      return result;
    },
    encode(canonical) {
      const result: Partial<ClaudeCodeNative> = {};

      const perms = canonical.permissions;
      if (perms) {
        if (perms.allow) result.allow = perms.allow;
        if (perms.deny) result.deny = perms.deny;
        if (perms.ask) result.ask = perms.ask;
        if (perms.additionalDirectories)
          result.additionalDirectories = perms.additionalDirectories;
      }

      // defaultMode — only include modes that Claude Code accepts
      const ccDefaultMode = canonical.defaultMode ?? perms?.defaultMode;
      if (ccDefaultMode) {
        // Only Claude Code's native modes are valid in the output
        const claudeCodeModes = [
          "acceptEdits",
          "auto",
          "bypassPermissions",
          "default",
          "dontAsk",
          "plan",
        ] as const;
        const match = claudeCodeModes.find((m) => m === ccDefaultMode);
        if (match) {
          result.defaultMode = match;
        }
      }

      return result;
    },
  },
);

// ---------------------------------------------------------------------------
// OpenCode codec
// ---------------------------------------------------------------------------
// OpenCode uses `{ tool: { pattern: "action" } }` with last-match-wins.
// Pattern syntax differs: space-separated (`"git *"`) vs our `:*` prefix.
// Tool names differ: lowercase (`edit`, `list`) vs our PascalCase (`Edit`, `Glob`).

const ocAction = PermissionBehavior;

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
      todowrite: ocAction.optional(),
      question: ocAction.optional(),
      webfetch: ocAction.optional(),
      websearch: ocAction.optional(),
      lsp: ocRule.optional(),
      doom_loop: ocAction.optional(),
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
  codesearch: "Grep", // codesearch ≈ Grep
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
function ocPatternToCanonical(tool: string, pattern: string): string {
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

/** Tools with no canonical mapping — silently skipped during decode. */
const OC_UNMAPPED_TOOLS = new Set([
  "doom_loop",
  "lsp",
  "skill",
  "question",
  "todowrite",
]);

export const opencodeCodec = z.codec(opencodeNative, agentPermissionPolicy, {
  decode(native) {
    // Shorthand "allow"/"deny" applies to everything
    if (typeof native === "string") {
      const mode =
        native === "allow"
          ? ("autonomous" as const)
          : native === "deny"
            ? ("restricted" as const)
            : ("standard" as const);
      return { defaultMode: mode };
    }

    const perms: Partial<PermissionTiers> = {};
    const allow: string[] = [];
    const deny: string[] = [];
    const ask: string[] = [];
    let sandbox: Partial<Sandbox> | undefined;

    for (const [ocTool, rule] of Object.entries(native)) {
      if (rule === undefined) continue;
      if (OC_UNMAPPED_TOOLS.has(ocTool)) continue;

      if (ocTool === "external_directory") {
        if (typeof rule === "object") {
          const allowedDirs: string[] = [];
          for (const [dir, action] of Object.entries(rule)) {
            if (action === "allow") allowedDirs.push(dir);
          }
          if (allowedDirs.length > 0) {
            perms.additionalDirectories = allowedDirs;
            sandbox = { writableRoots: allowedDirs };
          }
        }
        continue;
      }

      if (typeof rule === "string") {
        // Shorthand action for entire tool
        const canonicalRule = ocToCanonical[ocTool] ?? ocTool;
        if (rule === "allow") allow.push(canonicalRule);
        else if (rule === "deny") deny.push(canonicalRule);
        else ask.push(canonicalRule);
      } else {
        // Granular patterns: { "git *": "allow", "rm *": "deny" }
        for (const [pattern, action] of Object.entries(rule)) {
          const canonicalRule = ocPatternToCanonical(ocTool, pattern);
          if (action === "allow") allow.push(canonicalRule);
          else if (action === "deny") deny.push(canonicalRule);
          else ask.push(canonicalRule);
        }
      }
    }

    if (allow.length > 0) perms.allow = allow;
    if (deny.length > 0) perms.deny = deny;
    if (ask.length > 0) perms.ask = ask;

    const result: Partial<AgentPermissionPolicy> = {};
    if (Object.keys(perms).length > 0) result.permissions = perms;
    if (sandbox) result.sandbox = sandbox;
    return result;
  },
  encode(canonical) {
    const perms = canonical.permissions;

    if (!perms) return { bash: "ask" };

    const result: Record<string, Record<string, "allow" | "deny" | "ask">> = {};

    const allRules: { rule: string; action: "allow" | "deny" | "ask" }[] = [
      ...(perms.allow?.map((r) => ({ rule: r, action: "allow" as const })) ??
        []),
      ...(perms.deny?.map((r) => ({ rule: r, action: "deny" as const })) ?? []),
      ...(perms.ask?.map((r) => ({ rule: r, action: "ask" as const })) ?? []),
    ];

    for (const { rule, action } of allRules) {
      const parsed = canonicalToOcPattern(rule);
      if (!parsed) continue;

      let toolRules = result[parsed.tool];
      if (!toolRules) {
        toolRules = {};
        result[parsed.tool] = toolRules;
      }
      toolRules[parsed.pattern] = action;
    }

    // Map sandbox.writableRoots → external_directory
    if (canonical.sandbox?.writableRoots?.length) {
      const extDir: Record<string, "allow"> = {};
      for (const root of canonical.sandbox.writableRoots) {
        extDir[root] = "allow";
      }
      result.external_directory = extDir;
    }

    // If any tool has only a single "*" pattern, simplify to shorthand
    const simplified: Record<string, unknown> = { ...result };
    for (const [tool, patterns] of Object.entries(result)) {
      if (tool === "external_directory") continue;
      const keys = Object.keys(patterns);
      if (keys.length === 1 && keys[0] === "*") {
        simplified[tool] = patterns["*"];
      }
    }

    return simplified;
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
  multiedit: "Edit",
  write: "Write",
  bash: "Bash",
  fetch: "WebFetch",
  agentic_fetch: "WebFetch",
  glob: "Glob",
  download: "WebFetch",
  sourcegraph: "Grep",
  agent: "Agent",
  todos: "Agent",
};

const canonicalToCrush: Record<string, string> = {
  Read: "view",
  Glob: "glob",
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
    return { permissions: { allow } };
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
//   approval_policy: "untrusted" | "on-request" | "on-failure" | "never" | { granular: {...} }
//   sandbox_mode: "read-only" | "workspace-write" | "danger-full-access"
//   permissions: named profiles with filesystem + network rules
//   default_permissions: name of the active profile
//   sandbox_workspace_write: writable_roots, network_access
//
// Mapping:
//   approval_policy ↔ defaultMode
//   sandbox_mode → sandbox.mode + defaultMode
//   sandbox_workspace_write → sandbox.writableRoots + sandbox.networkAccess
//   permissions.<name>.filesystem → deny rules with Read/Write/Edit patterns
//   permissions.<name>.network.domains → network.domains + WebFetch rules
//   named profiles → profiles record + activeProfile

const codexApprovalPolicy = z.union([
  CodexApprovalMode,
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

type CodexApprovalPolicy = z.infer<typeof codexApprovalPolicy>;

/**
 * Codex native config object — what a TOML parser produces from codex config.
 * Only the permission-relevant fields; the full schema has 60+ keys.
 */
const codexNative = z.object({
  approval_policy: codexApprovalPolicy.optional(),
  sandbox_mode: CodexSandboxMode.optional(),
  default_permissions: z.string().optional(),
  sandbox_workspace_write: z
    .object({
      writable_roots: z.array(z.string()).optional(),
      network_access: z.boolean().optional(),
      exclude_slash_tmp: z.boolean().optional(),
      exclude_tmpdir_env_var: z.boolean().optional(),
    })
    .partial()
    .optional(),
  // Named permission profiles: { [name]: { filesystem: { ... }, network: { ... } } }
  permissions: z
    .record(
      z.string(),
      z.object({
        filesystem: z
          .union([
            // Shorthand: apply single mode to entire workspace
            CodexFilesystemAccess,
            // Granular: { "/path": "read" | "write" | "none" }
            z.record(z.string(), CodexFilesystemAccess),
          ])
          .optional(),
        network: z
          .object({
            enabled: z.boolean().optional(),
            domains: z.record(z.string(), CodexDomainAccess).optional(),
          })
          .partial()
          .optional(),
      }),
    )
    .optional(),
});

type CodexNative = z.infer<typeof codexNative>;
type CodexSandboxWorkspaceWrite = NonNullable<
  CodexNative["sandbox_workspace_write"]
>;

export interface CodexProfile {
  filesystem?:
    | CodexFilesystemAccess
    | Record<string, CodexFilesystemAccess>
    | undefined;
  network?:
    | {
        enabled?: boolean | undefined;
        domains?: Record<string, "allow" | "deny"> | undefined;
      }
    | undefined;
}

/**
 * Map Codex approval_policy to canonical defaultMode.
 */
function codexApprovalToMode(
  policy: CodexApprovalPolicy,
): AgentPermissionPolicy["defaultMode"] {
  if (typeof policy === "string") {
    switch (policy) {
      case "untrusted":
        return "restricted";
      case "on-request":
        return "standard";
      case "on-failure":
        return "standard";
      case "never":
        return "autonomous";
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
): CodexApprovalPolicy {
  if (
    mode === "autonomous" ||
    mode === "bypassPermissions" ||
    mode === "dontAsk"
  ) {
    return "never";
  }
  if (mode === "restricted" || mode === "plan" || mode === "readonly") {
    return "untrusted";
  }
  // standard, acceptEdits, default
  return "on-request";
}

/**
 * Map Codex sandbox_mode to canonical sandbox.mode.
 */
function codexSandboxToCanonical(
  mode: z.infer<typeof CodexSandboxMode>,
): "readonly" | "workspace-write" | "full-access" {
  switch (mode) {
    case "read-only":
      return "readonly";
    case "workspace-write":
      return "workspace-write";
    case "danger-full-access":
      return "full-access";
  }
}

/**
 * Map canonical sandbox.mode back to Codex sandbox_mode.
 */
function canonicalSandboxToCodex(
  mode: "readonly" | "workspace-write" | "full-access",
): z.infer<typeof CodexSandboxMode> {
  switch (mode) {
    case "readonly":
      return "read-only";
    case "workspace-write":
      return "workspace-write";
    case "full-access":
      return "danger-full-access";
  }
}

/**
 * Map Codex filesystem access mode to canonical deny rules.
 * Codex paths are absolute; we convert to relative where possible.
 */
function codexFilesystemToRules(
  fs: CodexFilesystemAccess | Record<string, CodexFilesystemAccess>,
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
    const allow: string[] = [];
    const deny: string[] = [];
    const networkDomains: Record<string, "allow" | "deny"> = {};
    const namedProfiles: Record<string, Partial<PermissionTiers>> = {};

    // --- approval_policy → defaultMode ---
    let defaultMode: AgentPermissionPolicy["defaultMode"] | undefined;
    if (native.approval_policy) {
      defaultMode = codexApprovalToMode(native.approval_policy);
    }

    // --- sandbox_mode → sandbox.mode ---
    let sandbox: Partial<Sandbox> | undefined;
    if (native.sandbox_mode) {
      sandbox = { mode: codexSandboxToCanonical(native.sandbox_mode) };
    }

    // --- sandbox_workspace_write → sandbox fields ---
    if (native.sandbox_workspace_write) {
      sandbox ??= {};
      if (native.sandbox_workspace_write.writable_roots?.length) {
        sandbox.writableRoots = native.sandbox_workspace_write.writable_roots;
      }
      if (native.sandbox_workspace_write.network_access !== undefined) {
        sandbox.networkAccess = native.sandbox_workspace_write.network_access;
      }
    }

    // --- sandbox_mode "read-only" override ---
    if (native.sandbox_mode === "read-only") {
      defaultMode = "readonly";
      deny.push("Write", "Edit");
    } else if (native.sandbox_mode === "danger-full-access") {
      if (!native.approval_policy) defaultMode = "autonomous";
    }

    // --- Named permission profiles ---
    const allProfiles = native.permissions ?? {};
    const activeProfileName = native.default_permissions;

    for (const [name, profile] of Object.entries(allProfiles)) {
      const profileAllow: string[] = [];
      const profileDeny: string[] = [];

      if (profile.filesystem) {
        codexFilesystemToRules(profile.filesystem, profileDeny);
      }

      if (profile.network?.domains) {
        for (const [domain, action] of Object.entries(
          profile.network.domains,
        )) {
          if (action === "allow")
            profileAllow.push(`WebFetch(domain:${domain})`);
          else profileDeny.push(`WebFetch(domain:${domain})`);
        }
      }

      // If this is the active profile, also contribute to top-level rules
      if (!activeProfileName || name === activeProfileName) {
        allow.push(...profileAllow);
        deny.push(...profileDeny);

        // Collect domain rules for top-level network
        if (profile.network?.domains) {
          Object.assign(networkDomains, profile.network.domains);
        }
      }

      // Store as named profile
      const profileTiers: Partial<PermissionTiers> = {};
      if (profileAllow.length > 0) profileTiers.allow = profileAllow;
      if (profileDeny.length > 0) profileTiers.deny = profileDeny;
      if (Object.keys(profileTiers).length > 0) {
        namedProfiles[name] = profileTiers;
      }
    }

    // Build result
    const result: Partial<AgentPermissionPolicy> = {};
    if (defaultMode !== undefined) result.defaultMode = defaultMode;
    if (sandbox) result.sandbox = sandbox;

    if (allow.length > 0 || deny.length > 0) {
      const perms: Partial<PermissionTiers> = {};
      if (allow.length > 0) perms.allow = allow;
      if (deny.length > 0) perms.deny = deny;
      result.permissions = perms;
    }

    if (Object.keys(namedProfiles).length > 0) {
      result.profiles = namedProfiles;
      if (activeProfileName) result.activeProfile = activeProfileName;
    }

    if (Object.keys(networkDomains).length > 0) {
      result.network = { domains: networkDomains };
    }

    return result;
  },
  encode(canonical) {
    const result: Partial<CodexNative> = {};
    const perms = canonical.permissions;

    // --- defaultMode → approval_policy ---
    if (canonical.defaultMode) {
      result.approval_policy = modeToCodexApproval(canonical.defaultMode);
    }

    // --- sandbox → sandbox_mode + sandbox_workspace_write ---
    if (canonical.sandbox) {
      if (canonical.sandbox.mode) {
        result.sandbox_mode = canonicalSandboxToCodex(canonical.sandbox.mode);
      }
      if (
        canonical.sandbox.writableRoots?.length ||
        canonical.sandbox.networkAccess !== undefined
      ) {
        const sw: Partial<CodexSandboxWorkspaceWrite> = {};
        if (canonical.sandbox.writableRoots?.length) {
          sw.writable_roots = canonical.sandbox.writableRoots;
        }
        if (canonical.sandbox.networkAccess !== undefined) {
          sw.network_access = canonical.sandbox.networkAccess;
        }
        result.sandbox_workspace_write = sw;
      }
    } else if (canonical.defaultMode) {
      // Derive sandbox_mode from defaultMode if no explicit sandbox
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
    if (
      perms?.additionalDirectories?.length &&
      !result.sandbox_workspace_write
    ) {
      result.sandbox_workspace_write = {
        writable_roots: perms.additionalDirectories,
      };
    }

    // --- network.domains → Codex network.domains ---
    const domains: Record<string, "allow" | "deny"> = {};
    if (canonical.network?.domains) {
      for (const [domain, action] of Object.entries(
        canonical.network.domains,
      )) {
        domains[domain] = action;
      }
    }

    // Also extract WebFetch rules from deny/allow
    const filesystemDenyTools: Record<string, Set<string>> = {};

    for (const rule of perms?.deny ?? []) {
      const parsed = parseToolPathPattern(rule);
      if (parsed) {
        let tools = filesystemDenyTools[parsed.path];
        if (!tools) {
          tools = new Set();
          filesystemDenyTools[parsed.path] = tools;
        }
        tools.add(parsed.tool);
        continue;
      }

      const domainMatch = /^WebFetch\(domain:(.+)\)$/.exec(rule);
      if (domainMatch?.[1]) {
        domains[domainMatch[1]] = "deny";
      }
    }

    for (const rule of perms?.allow ?? []) {
      const domainMatch = /^WebFetch\(domain:(.+)\)$/.exec(rule);
      if (domainMatch?.[1]) {
        domains[domainMatch[1]] = "allow";
      }
    }

    // Convert collected path denies to Codex filesystem modes
    const filesystem: Record<string, CodexFilesystemAccess> = {};
    for (const [path, tools] of Object.entries(filesystemDenyTools)) {
      if (tools.has("Read")) {
        filesystem[path] = "none";
      } else if (tools.has("Write") || tools.has("Edit")) {
        filesystem[path] = "read";
      }
    }

    // --- profiles → named Codex profiles ---
    if (canonical.profiles && Object.keys(canonical.profiles).length > 0) {
      const codexProfiles: Record<string, CodexProfile> = {};
      for (const [name, profileTiers] of Object.entries(canonical.profiles)) {
        const profile: CodexProfile = {};
        const profDenyTools: Record<string, Set<string>> = {};
        const profDomains: Record<string, "allow" | "deny"> = {};

        for (const rule of profileTiers.deny ?? []) {
          const parsed = parseToolPathPattern(rule);
          if (parsed) {
            let tools = profDenyTools[parsed.path];
            if (!tools) {
              tools = new Set();
              profDenyTools[parsed.path] = tools;
            }
            tools.add(parsed.tool);
          }
          const dm = /^WebFetch\(domain:(.+)\)$/.exec(rule);
          if (dm?.[1]) profDomains[dm[1]] = "deny";
        }
        for (const rule of profileTiers.allow ?? []) {
          const dm = /^WebFetch\(domain:(.+)\)$/.exec(rule);
          if (dm?.[1]) profDomains[dm[1]] = "allow";
        }

        const profFs: Record<string, CodexFilesystemAccess> = {};
        for (const [path, tools] of Object.entries(profDenyTools)) {
          if (tools.has("Read")) profFs[path] = "none";
          else if (tools.has("Write") || tools.has("Edit"))
            profFs[path] = "read";
        }

        if (Object.keys(profFs).length > 0) {
          const absoluteFs: Record<string, CodexFilesystemAccess> = {};
          for (const [p, m] of Object.entries(profFs)) {
            absoluteFs[p.startsWith(".") ? p.slice(1) : p] = m;
          }
          profile.filesystem = absoluteFs;
        }
        if (Object.keys(profDomains).length > 0) {
          profile.network = { domains: profDomains };
        }

        if (Object.keys(profile).length > 0) {
          codexProfiles[name] = profile;
        }
      }

      if (Object.keys(codexProfiles).length > 0) {
        result.permissions = codexProfiles;
        if (canonical.activeProfile) {
          result.default_permissions = canonical.activeProfile;
        }
      }
    } else if (
      Object.keys(filesystem).length > 0 ||
      Object.keys(domains).length > 0
    ) {
      // No named profiles — create a single "default" profile from deny/allow rules
      const profile: CodexProfile = {};
      if (Object.keys(filesystem).length > 0) {
        const absoluteFs: Record<string, CodexFilesystemAccess> = {};
        for (const [p, m] of Object.entries(filesystem)) {
          absoluteFs[p.startsWith(".") ? p.slice(1) : p] = m;
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

    return result;
  },
});

/**
 * Parse a canonical tool-path pattern like `Read(./src/**)` or `Write(./config)`.
 * Returns the tool name and path, or undefined if not a file-path rule.
 */
function parseToolPathPattern(
  rule: string,
): { tool: string; path: string } | undefined {
  const match = /^(Read|Write|Edit)\((.+)\)$/.exec(rule);
  if (!match?.[1] || !match[2]) return undefined;
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
