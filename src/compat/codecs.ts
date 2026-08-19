/**
 * Agent compatibility codecs — bidirectional transforms between our canonical
 * `.agents/permissions.json` format and each agent's native permission config.
 *
 * Usage: decode: agent native config → canonical AgentPermissionPolicy encode: canonical
 * AgentPermissionPolicy → agent native config
 *
 * Import { claudeCodeCodec } from "./compat/codecs.js";
 *
 * // Read Claude Code settings and convert to canonical const canonical =
 * claudeCodeCodec.decode(claudeSettings.permissions);
 *
 * // Write canonical policy back out as Claude Code settings const claudePermBlock =
 * z.encode(claudeCodeCodec, canonical);
 */

import * as z from "zod";
import {
  AgentPermissionPolicy,
  type PermissionTiers,
  type Rule,
  type Sandbox,
} from "../schema.ts";
import {
  normaliseStringRule,
  ruleToString,
  collectRules,
} from "../evaluate.ts";
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

export const agentId = z.enum([
  "claude-code",
  "codex",
  "kiro",
  "opencode",
  "crush",
  "omp",
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
    defaultMode: ClaudeCodePermissionMode.optional(),
    additionalDirectories: z.array(z.string()).optional(),
  })
  .partial()
  .strict();

type ClaudeCodeNative = z.infer<typeof claudeCodeNative>;

export const claudeCodeCodec = z.codec(
  claudeCodeNative,
  AgentPermissionPolicy,
  {
    decode(native) {
      const rules: Rule[] = [];

      if (native.deny) {
        rules.push(...native.deny.map((r) => normaliseStringRule(r, "deny")));
      }
      if (native.ask) {
        rules.push(...native.ask.map((r) => normaliseStringRule(r, "ask")));
      }
      if (native.allow) {
        rules.push(...native.allow.map((r) => normaliseStringRule(r, "allow")));
      }

      const result: Partial<AgentPermissionPolicy> = {};
      if (rules.length > 0) result.rules = rules;
      if (native.additionalDirectories?.length) {
        result.permissions = {
          additionalDirectories: native.additionalDirectories,
        };
      }
      if (native.defaultMode) {
        result.defaultMode = native.defaultMode;
      }

      return result;
    },
    encode(canonical) {
      const result: Partial<ClaudeCodeNative> = {};

      const allRules = collectRules(canonical);
      if (allRules.length > 0) {
        result.deny = allRules
          .filter((r) => r.tier === "deny")
          .map(ruleToString);
        result.ask = allRules.filter((r) => r.tier === "ask").map(ruleToString);
        result.allow = allRules
          .filter((r) => r.tier === "allow")
          .map(ruleToString);
      }

      if (canonical.permissions?.additionalDirectories?.length) {
        result.additionalDirectories =
          canonical.permissions.additionalDirectories;
      }

      // defaultMode — only include modes that Claude Code accepts
      const ccDefaultMode =
        canonical.defaultMode ?? canonical.permissions?.defaultMode;
      if (ccDefaultMode) {
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

/** Map OpenCode tool names to our canonical names. OpenCode uses lowercase; we use PascalCase. */
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
 * Map canonical tool names back to OpenCode tool names. Each canonical tool maps to the primary
 * OpenCode equivalent.
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

/** Tools with no canonical mapping — silently skipped during decode. */
const OC_UNMAPPED_TOOLS = new Set([
  "doom_loop",
  "lsp",
  "skill",
  "question",
  "todowrite",
]);

export const opencodeCodec = z.codec(opencodeNative, AgentPermissionPolicy, {
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

    const rules: Rule[] = [];
    let sandbox: Partial<Sandbox> | undefined;
    const additionalDirectories: string[] = [];

    for (const [ocTool, rule] of Object.entries(native)) {
      if (rule === undefined) continue;
      if (OC_UNMAPPED_TOOLS.has(ocTool)) continue;

      if (ocTool === "external_directory") {
        if (typeof rule === "object") {
          for (const [dir, action] of Object.entries(rule)) {
            if (action === "allow") additionalDirectories.push(dir);
          }
        }
        continue;
      }

      if (typeof rule === "string") {
        // Shorthand action for entire tool
        const canonicalTool = ocToCanonical[ocTool] ?? ocTool;
        rules.push({
          tool: canonicalTool,
          tier: rule,
        });
      } else {
        // Granular patterns: { "git *": "allow", "rm *": "deny" }
        for (const [pattern, action] of Object.entries(rule)) {
          const canonicalTool = ocToCanonical[ocTool] ?? ocTool;
          rules.push({
            tool: canonicalTool,
            // Wrap bare pattern — no Tool(...) wrapper needed in structured rules
            pattern,
            tier: action,
          });
        }
      }
    }

    const result: Partial<AgentPermissionPolicy> = {};
    if (rules.length > 0) result.rules = rules;
    if (additionalDirectories.length > 0) {
      result.permissions = { additionalDirectories };
      sandbox = { writableRoots: additionalDirectories };
    }
    if (sandbox) result.sandbox = sandbox;
    return result;
  },
  encode(canonical) {
    const allRules = collectRules(canonical);
    if (allRules.length === 0) return { bash: "ask" };

    const result: Record<string, Record<string, "allow" | "deny" | "ask">> = {};

    for (const rule of allRules) {
      const ocTool = canonicalToOc[rule.tool];
      if (!ocTool) continue;

      const pattern = rule.pattern ? rule.pattern.replace(/:\*$/, " *") : "*";

      let toolRules = result[ocTool];
      if (!toolRules) {
        toolRules = {};
        result[ocTool] = toolRules;
      }
      toolRules[pattern] = rule.tier;
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

/** Map Crush tool names to canonical names. */
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

export const crushCodec = z.codec(crushNative, AgentPermissionPolicy, {
  decode(native) {
    const rules: Rule[] = [];
    for (const tool of native.allowed_tools) {
      // MCP tools pass through as-is (mcp_server_tool format)
      const canonical = crushToCanonical[tool] ?? tool;
      rules.push({ tool: canonical, tier: "allow" });
    }
    return { rules };
  },
  encode(canonical) {
    const allRules = collectRules(canonical);
    const allowed: string[] = [];
    for (const rule of allRules) {
      // Only bare allow rules — Crush has no deny, no patterns
      if (rule.tier !== "allow") continue;
      if (rule.pattern !== undefined) continue;
      const crushTool = canonicalToCrush[rule.tool];
      if (crushTool) allowed.push(crushTool);
    }
    return { allowed_tools: allowed };
  },
});

// ---------------------------------------------------------------------------
// Kiro (Amazon) codec
// ---------------------------------------------------------------------------
// Kiro uses declarative per-agent JSON configs with interactive tiered trust.
// No SDK — alignment by manual review of https://kiro.dev/docs/.
//
// Key concepts:
//   allowedTools: auto-approved tools (glob patterns with * and ?)
//   toolsSettings.shell.allowedCommands/deniedCommands: regex patterns
//   toolsSettings.shell.autoAllowReadonly / denyByDefault: booleans
//   toolsSettings.<tool>.allowedPaths/deniedPaths: path globs
//   toolsSettings.aws.allowedServices/deniedServices: service names
//   toolsSettings.web_fetch.trusted/blocked: regex URL patterns
//
// Mapping:
//   allowedTools → allow rules (bare tool or MCP glob)
//   toolsSettings.shell.deniedCommands → deny Bash rules
//   toolsSettings.shell.allowedCommands → allow Bash rules
//   toolsSettings.<tool>.deniedPaths → deny rules for that tool
//   toolsSettings.<tool>.allowedPaths → allow rules for that tool
//   toolsSettings.web_fetch.blocked/trusted → deny/allow WebFetch (domain: regex)
//   toolsSettings.shell.denyByDefault → defaultMode "restricted"
//   toolsSettings.shell.autoAllowReadonly → allow Bash rules for readonly

/** Kiro → canonical tool name mapping. */
const kiroToCanonical: Record<string, string> = {
  read: "Read",
  write: "Write",
  shell: "Bash",
  aws: "Aws",
  glob: "Glob",
  grep: "Grep",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  code: "Code",
  delegate: "Delegate",
  subagent: "Agent",
};

/** Canonical → Kiro tool name mapping (reverse of kiroToCanonical). */
const canonicalToKiro: Record<string, string> = {};
for (const [kiro, canonical] of Object.entries(kiroToCanonical)) {
  canonicalToKiro[canonical] = kiro;
}

/**
 * Strip Kiro regex anchors (\A → ^, \z → $) from a pattern for canonical use. Kiro auto-anchors
 * with \A/\z; we store the pattern without anchors.
 */
function stripKiroAnchors(pattern: string): string {
  return pattern.replace(/^\\A/, "").replace(/\\z$/, "");
}

/** Add Kiro regex anchors to a pattern for native output. */
function addKiroAnchors(pattern: string): string {
  return `\\A${pattern}\\z`;
}

/** Check if a Kiro allowedTools entry is an MCP reference (starts with @) vs a built-in tool name. */
function isKiroMcpRef(entry: string): boolean {
  return entry.startsWith("@");
}

/**
 * Convert a Kiro allowedTools glob pattern to canonical pattern syntax. Kiro uses * and ? globs;
 * MCP refs use @server/tool format.
 */
function kiroGlobToPattern(glob: string): string | undefined {
  if (!isKiroMcpRef(glob) && !glob.includes("*") && !glob.includes("?"))
    return undefined;
  return glob;
}

const kiroNative = z.object({
  allowedTools: z.array(z.string()).optional(),
  toolsSettings: z
    .object({
      shell: z
        .object({
          allowedCommands: z.array(z.string()).optional(),
          deniedCommands: z.array(z.string()).optional(),
          autoAllowReadonly: z.boolean().optional(),
          denyByDefault: z.boolean().optional(),
        })
        .partial()
        .optional(),
      read: z
        .object({
          allowedPaths: z.array(z.string()).optional(),
          deniedPaths: z.array(z.string()).optional(),
        })
        .partial()
        .optional(),
      write: z
        .object({
          allowedPaths: z.array(z.string()).optional(),
          deniedPaths: z.array(z.string()).optional(),
        })
        .partial()
        .optional(),
      aws: z
        .object({
          allowedServices: z.array(z.string()).optional(),
          deniedServices: z.array(z.string()).optional(),
          autoAllowReadonly: z.boolean().optional(),
        })
        .partial()
        .optional(),
      web_fetch: z
        .object({
          trusted: z.array(z.string()).optional(),
          blocked: z.array(z.string()).optional(),
        })
        .partial()
        .optional(),
    })
    .partial()
    .optional(),
});

type KiroNative = z.infer<typeof kiroNative>;

export const kiroCodec = z.codec(kiroNative, AgentPermissionPolicy, {
  decode(native) {
    const rules: Rule[] = [];
    const result: Partial<AgentPermissionPolicy> = {};

    // --- allowedTools → allow rules ---
    if (native.allowedTools) {
      for (const entry of native.allowedTools) {
        if (isKiroMcpRef(entry)) {
          // MCP reference: @server, @server/tool, @server/prefix_*
          rules.push({ tool: entry, tier: "allow" });
        } else {
          const canonical = kiroToCanonical[entry] ?? entry;
          const pattern = kiroGlobToPattern(entry);
          rules.push({
            tool: canonical,
            tier: "allow",
            ...(pattern && { pattern }),
          });
        }
      }
    }

    // --- toolsSettings ---
    const ts = native.toolsSettings;
    if (ts) {
      // Shell (Bash)
      if (ts.shell) {
        if (ts.shell.deniedCommands) {
          for (const cmd of ts.shell.deniedCommands) {
            rules.push({
              tool: "Bash",
              pattern: stripKiroAnchors(cmd),
              tier: "deny",
            });
          }
        }
        if (ts.shell.allowedCommands) {
          for (const cmd of ts.shell.allowedCommands) {
            rules.push({
              tool: "Bash",
              pattern: stripKiroAnchors(cmd),
              tier: "allow",
            });
          }
        }
        if (ts.shell.denyByDefault) {
          result.defaultMode = "restricted";
        }
        // autoAllowReadonly is a Kiro-specific behaviour flag; no canonical mapping
      }

      // Read paths
      if (ts.read) {
        if (ts.read.deniedPaths) {
          for (const path of ts.read.deniedPaths) {
            rules.push({ tool: "Read", pattern: path, tier: "deny" });
          }
        }
        if (ts.read.allowedPaths) {
          for (const path of ts.read.allowedPaths) {
            rules.push({ tool: "Read", pattern: path, tier: "allow" });
          }
        }
      }

      // Write paths
      if (ts.write) {
        if (ts.write.deniedPaths) {
          for (const path of ts.write.deniedPaths) {
            rules.push({ tool: "Write", pattern: path, tier: "deny" });
          }
        }
        if (ts.write.allowedPaths) {
          for (const path of ts.write.allowedPaths) {
            rules.push({ tool: "Write", pattern: path, tier: "allow" });
          }
        }
      }

      // AWS services
      if (ts.aws) {
        if (ts.aws.deniedServices) {
          for (const svc of ts.aws.deniedServices) {
            rules.push({
              tool: "Aws",
              pattern: `service:${svc}`,
              tier: "deny",
            });
          }
        }
        if (ts.aws.allowedServices) {
          for (const svc of ts.aws.allowedServices) {
            rules.push({
              tool: "Aws",
              pattern: `service:${svc}`,
              tier: "allow",
            });
          }
        }
      }

      // Web fetch (URL regex → domain-like patterns)
      if (ts.web_fetch) {
        if (ts.web_fetch.blocked) {
          for (const urlPattern of ts.web_fetch.blocked) {
            rules.push({
              tool: "WebFetch",
              pattern: `url:${stripKiroAnchors(urlPattern)}`,
              tier: "deny",
            });
          }
        }
        if (ts.web_fetch.trusted) {
          for (const urlPattern of ts.web_fetch.trusted) {
            rules.push({
              tool: "WebFetch",
              pattern: `url:${stripKiroAnchors(urlPattern)}`,
              tier: "allow",
            });
          }
        }
      }
    }

    if (rules.length > 0) result.rules = rules;
    return result;
  },

  encode(canonical) {
    const allRules = collectRules(canonical);
    const result: Partial<KiroNative> = {};

    const allowedTools: string[] = [];
    const shellSettings: NonNullable<KiroNative["toolsSettings"]>["shell"] = {};
    const readSettings: NonNullable<KiroNative["toolsSettings"]>["read"] = {};
    const writeSettings: NonNullable<KiroNative["toolsSettings"]>["write"] = {};
    const awsSettings: NonNullable<KiroNative["toolsSettings"]>["aws"] = {};
    const webFetchSettings: NonNullable<
      KiroNative["toolsSettings"]
    >["web_fetch"] = {};

    for (const rule of allRules) {
      const kiroTool = canonicalToKiro[rule.tool];

      // Bare allow rules (no pattern) → allowedTools
      if (rule.tier === "allow" && rule.pattern === undefined) {
        if (isKiroMcpRef(rule.tool)) {
          allowedTools.push(rule.tool);
        } else if (kiroTool) {
          allowedTools.push(kiroTool);
        }
        continue;
      }

      // Patterned rules → toolsSettings
      if (rule.tool === "Bash" && rule.pattern !== undefined) {
        if (rule.tier === "deny") {
          shellSettings.deniedCommands ??= [];
          shellSettings.deniedCommands.push(addKiroAnchors(rule.pattern));
        } else if (rule.tier === "allow") {
          shellSettings.allowedCommands ??= [];
          shellSettings.allowedCommands.push(addKiroAnchors(rule.pattern));
        }
      } else if (rule.tool === "Read" && rule.pattern !== undefined) {
        if (rule.tier === "deny") {
          readSettings.deniedPaths ??= [];
          readSettings.deniedPaths.push(rule.pattern);
        } else if (rule.tier === "allow") {
          readSettings.allowedPaths ??= [];
          readSettings.allowedPaths.push(rule.pattern);
        }
      } else if (rule.tool === "Write" && rule.pattern !== undefined) {
        if (rule.tier === "deny") {
          writeSettings.deniedPaths ??= [];
          writeSettings.deniedPaths.push(rule.pattern);
        } else if (rule.tier === "allow") {
          writeSettings.allowedPaths ??= [];
          writeSettings.allowedPaths.push(rule.pattern);
        }
      } else if (rule.tool === "Aws" && rule.pattern?.startsWith("service:")) {
        const svc = rule.pattern.slice("service:".length);
        if (rule.tier === "deny") {
          awsSettings.deniedServices ??= [];
          awsSettings.deniedServices.push(svc);
        } else if (rule.tier === "allow") {
          awsSettings.allowedServices ??= [];
          awsSettings.allowedServices.push(svc);
        }
      } else if (rule.tool === "WebFetch" && rule.pattern?.startsWith("url:")) {
        const urlPattern = rule.pattern.slice("url:".length);
        if (rule.tier === "deny") {
          webFetchSettings.blocked ??= [];
          webFetchSettings.blocked.push(addKiroAnchors(urlPattern));
        } else if (rule.tier === "allow") {
          webFetchSettings.trusted ??= [];
          webFetchSettings.trusted.push(addKiroAnchors(urlPattern));
        }
      }
    }

    if (canonical.defaultMode === "restricted") {
      shellSettings.denyByDefault = true;
    }

    if (allowedTools.length > 0) result.allowedTools = allowedTools;

    const toolsSettings: NonNullable<KiroNative["toolsSettings"]> = {};
    if (Object.keys(shellSettings).length > 0)
      toolsSettings.shell = shellSettings;
    if (Object.keys(readSettings).length > 0) toolsSettings.read = readSettings;
    if (Object.keys(writeSettings).length > 0)
      toolsSettings.write = writeSettings;
    if (Object.keys(awsSettings).length > 0) toolsSettings.aws = awsSettings;
    if (Object.keys(webFetchSettings).length > 0)
      toolsSettings.web_fetch = webFetchSettings;
    if (Object.keys(toolsSettings).length > 0)
      result.toolsSettings = toolsSettings;

    return result;
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
 * Codex native config object — what a TOML parser produces from codex config. Only the
 * permission-relevant fields; the full schema has 60+ keys.
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
    CodexFilesystemAccess | Record<string, CodexFilesystemAccess> | undefined;
  network?:
    | {
        enabled?: boolean | undefined;
        domains?: Record<string, "allow" | "deny"> | undefined;
      }
    | undefined;
}

/** Map Codex approval_policy to canonical defaultMode. */
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

/** Map canonical defaultMode back to Codex approval_policy. */
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

/** Map Codex sandbox_mode to canonical sandbox.mode. */
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

/** Map canonical sandbox.mode back to Codex sandbox_mode. */
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
 * Map Codex filesystem access mode to canonical deny rules. Codex paths are absolute; we convert to
 * relative where possible.
 */
function codexFilesystemToRules(
  fs: CodexFilesystemAccess | Record<string, CodexFilesystemAccess>,
  rules: Rule[],
): void {
  if (typeof fs === "string") {
    if (fs === "read") {
      rules.push(
        { tool: "Write", tier: "deny" },
        { tool: "Edit", tier: "deny" },
      );
    } else if (fs === "none") {
      rules.push(
        { tool: "Read", tier: "deny" },
        { tool: "Write", tier: "deny" },
        { tool: "Edit", tier: "deny" },
      );
    }
    return;
  }

  for (const [path, mode] of Object.entries(fs)) {
    const rulePath = path.startsWith("/") ? `.${path}` : path;
    if (mode === "none") {
      rules.push(
        { tool: "Read", pattern: rulePath, tier: "deny" },
        { tool: "Write", pattern: rulePath, tier: "deny" },
        { tool: "Edit", pattern: rulePath, tier: "deny" },
      );
    } else if (mode === "read") {
      rules.push(
        { tool: "Write", pattern: rulePath, tier: "deny" },
        { tool: "Edit", pattern: rulePath, tier: "deny" },
      );
    }
  }
}

export const codexCodec = z.codec(codexNative, AgentPermissionPolicy, {
  decode(native) {
    const rules: Rule[] = [];
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
      rules.push(
        { tool: "Write", tier: "deny" },
        { tool: "Edit", tier: "deny" },
      );
    } else if (native.sandbox_mode === "danger-full-access") {
      if (!native.approval_policy) defaultMode = "autonomous";
    }

    // --- Named permission profiles ---
    const allProfiles = native.permissions ?? {};
    const activeProfileName = native.default_permissions;

    for (const [name, profile] of Object.entries(allProfiles)) {
      const profileRules: Rule[] = [];

      if (profile.filesystem) {
        codexFilesystemToRules(profile.filesystem, profileRules);
      }

      if (profile.network?.domains) {
        for (const [domain, action] of Object.entries(
          profile.network.domains,
        )) {
          profileRules.push({
            tool: "WebFetch",
            pattern: `domain:${domain}`,
            tier: action === "allow" ? "allow" : "deny",
          });
        }
      }

      // If this is the active profile, contribute to top-level rules
      if (!activeProfileName || name === activeProfileName) {
        rules.push(...profileRules);

        if (profile.network?.domains) {
          Object.assign(networkDomains, profile.network.domains);
        }
      }

      // Store as named profile (using string arrays for compat)
      if (profileRules.length > 0) {
        namedProfiles[name] = {
          deny: profileRules.filter((r) => r.tier === "deny").map(ruleToString),
          allow: profileRules
            .filter((r) => r.tier === "allow")
            .map(ruleToString),
        };
      }
    }

    // Build result
    const result: Partial<AgentPermissionPolicy> = {};
    if (defaultMode !== undefined) result.defaultMode = defaultMode;
    if (sandbox) result.sandbox = sandbox;
    if (rules.length > 0) result.rules = rules;

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
      canonical.permissions?.additionalDirectories?.length &&
      !result.sandbox_workspace_write
    ) {
      result.sandbox_workspace_write = {
        writable_roots: canonical.permissions.additionalDirectories,
      };
    }

    // --- Collect all rules and extract Codex-relevant info ---
    const allRules = collectRules(canonical);
    const domains: Record<string, "allow" | "deny"> = {};
    const filesystemDenyTools: Record<string, Set<string>> = {};

    // Extract network domains from canonical network config
    if (canonical.network?.domains) {
      for (const [domain, action] of Object.entries(
        canonical.network.domains,
      )) {
        domains[domain] = action;
      }
    }

    for (const rule of allRules) {
      // Extract WebFetch domain rules
      if (rule.tool === "WebFetch" && rule.pattern?.startsWith("domain:")) {
        const domain = rule.pattern.slice(7);
        domains[domain] = rule.tier === "deny" ? "deny" : "allow";
        continue;
      }

      // Extract path-based deny rules for filesystem mapping
      if (
        rule.tier === "deny" &&
        (rule.tool === "Read" ||
          rule.tool === "Write" ||
          rule.tool === "Edit") &&
        rule.pattern !== undefined
      ) {
        let tools = filesystemDenyTools[rule.pattern];
        if (!tools) {
          tools = new Set();
          filesystemDenyTools[rule.pattern] = tools;
        }
        tools.add(rule.tool);
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

        const profileRules = collectRules({ permissions: profileTiers });
        for (const rule of profileRules) {
          if (rule.tool === "WebFetch" && rule.pattern?.startsWith("domain:")) {
            const domain = rule.pattern.slice(7);
            profDomains[domain] = rule.tier === "deny" ? "deny" : "allow";
          }
          if (
            rule.tier === "deny" &&
            (rule.tool === "Read" ||
              rule.tool === "Write" ||
              rule.tool === "Edit") &&
            rule.pattern !== undefined
          ) {
            let tools = profDenyTools[rule.pattern];
            if (!tools) {
              tools = new Set();
              profDenyTools[rule.pattern] = tools;
            }
            tools.add(rule.tool);
          }
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
      // No named profiles — create a single "default" profile from rules
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

interface OmpNative {
  bash: {
    patterns: {
      match: string;
      approval: "allow" | "prompt" | "deny";
    }[];
  };
}

const ompApprovalToTier = {
  allow: "allow",
  prompt: "ask",
  deny: "deny",
} as const;

const tierToOmpApproval = {
  allow: "allow",
  ask: "prompt",
  deny: "deny",
} as const;

function decodeOmp(native: unknown): AgentPermissionPolicy {
  if (typeof native !== "object" || native === null || Array.isArray(native)) {
    return {};
  }

  const bash = (native as Record<string, unknown>).bash;
  if (typeof bash !== "object" || bash === null || Array.isArray(bash)) {
    return {};
  }

  const patterns = (bash as Record<string, unknown>).patterns;
  if (!Array.isArray(patterns)) return {};

  const rules: Rule[] = [];
  for (const pattern of patterns) {
    if (
      typeof pattern !== "object" ||
      pattern === null ||
      Array.isArray(pattern)
    ) {
      continue;
    }

    const entry = pattern as Record<string, unknown>;
    const tier =
      typeof entry.approval === "string"
        ? ompApprovalToTier[entry.approval as keyof typeof ompApprovalToTier]
        : undefined;
    if (typeof entry.match === "string" && tier !== undefined) {
      rules.push({ tool: "Bash", pattern: entry.match, tier });
    }
  }

  return rules.length === 0 ? {} : { rules };
}

function encodeOmp(canonical: AgentPermissionPolicy): OmpNative {
  const patterns = collectRules(canonical).flatMap((rule) => {
    if (rule.tool !== "Bash" || typeof rule.pattern !== "string") return [];

    return [
      {
        match: rule.pattern,
        approval: tierToOmpApproval[rule.tier],
      },
    ];
  });

  return { bash: { patterns } };
}

export const ompCodec = z.codec(z.unknown(), AgentPermissionPolicy, {
  decode: decodeOmp,
  encode: encodeOmp,
});

// ---------------------------------------------------------------------------
// Codec registry
// ---------------------------------------------------------------------------

export const CODECS = {
  "claude-code": claudeCodeCodec,
  codex: codexCodec,
  kiro: kiroCodec,
  opencode: opencodeCodec,
  crush: crushCodec,
  omp: ompCodec,
} as const;

export type Codecs = typeof CODECS;
