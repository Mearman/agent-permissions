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
  type PermissionMode,
  type PermissionTiers,
  type Rule,
  type Sandbox,
} from "../schema.ts";
import {
  normaliseStringRule,
  parseRulePattern,
  ruleToString,
  collectRules,
  mapMode,
} from "../evaluate.ts";
import { resolveProfiles } from "../profiles.ts";
import {
  UnsupportedCapabilityError,
  type UnsupportedRule,
  type UnsupportedSetting,
} from "./unsupported.ts";
import {
  ClaudeCodePermissionMode,
  CodexApprovalMode,
  CodexDomainAccess,
  CodexFilesystemAccess,
  CodexSandboxMode,
  PermissionBehavior,
} from "./enums.ts";

/**
 * The canonical rules as a codec for `agent` can hold them. No agent format can limit a rule to an
 * actor or a role, so a rule carrying either is not written as if it were unconditional: an allow is
 * left out, which is stricter, and a deny or ask is refused, since writing it would either widen the
 * rule or restrict everyone. An ask that names approvers is refused too: written plain, anyone the
 * agent's user is could approve it. All refused rules are reported together.
 *
 * @throws UnsupportedCapabilityError if a deny or ask rule is limited to an actor or a role, or an
 *   ask names approvers.
 */
function agentRules(
  policy: Parameters<typeof collectRules>[0],
  agent: string,
): Rule[] {
  const unsupported: UnsupportedRule[] = [];
  const kept = collectRules(policy).filter((rule) => {
    if (rule.approvers !== undefined) {
      unsupported.push({
        rule,
        reason: `${agent} cannot restrict who may approve a request`,
      });
      return false;
    }
    if (rule.when?.actor === undefined && rule.when?.role === undefined) {
      return true;
    }
    if (rule.tier !== "allow") {
      unsupported.push({
        rule,
        reason: `${agent} cannot limit a rule to an actor or a role`,
      });
    }
    return false;
  });
  if (unsupported.length > 0) {
    throw new UnsupportedCapabilityError(agent, unsupported);
  }
  return kept;
}

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

      const allRules = agentRules(canonical, "claude-code");
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
    const allRules = agentRules(canonical, "opencode");
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
    const allRules = agentRules(canonical, "crush");
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
    const allRules = agentRules(canonical, "kiro");
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

/** The file and network restrictions a set of rules puts on a Codex profile. */
interface CodexRestrictions {
  filesystem: Record<string, CodexFilesystemAccess>;
  domains: Record<string, "allow" | "deny">;
}

const FILE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit"]);
const DOMAIN_PREFIX = "domain:";

/** Why Codex cannot enforce a restrictive rule as written, or `undefined` when it can. */
function codexRefusal(
  rule: Rule,
  writesBlockedBySandbox: boolean,
): string | undefined {
  if (rule.when !== undefined) {
    return "Codex cannot limit a rule with a condition";
  }
  if (rule.approvers !== undefined) {
    return "Codex cannot restrict who may approve a request";
  }
  if (rule.tool === "WebFetch" && rule.pattern?.startsWith(DOMAIN_PREFIX)) {
    return rule.tier === "ask"
      ? "Codex network domains are allowed or denied, never asked"
      : undefined;
  }
  if (FILE_TOOLS.has(rule.tool)) {
    if (rule.pattern === undefined) {
      // A read-only sandbox already blocks every write, which is at least as strict as denying the tool.
      if (
        rule.tier === "deny" &&
        rule.tool !== "Read" &&
        writesBlockedBySandbox
      ) {
        return undefined;
      }
      return "Codex takes filesystem access per path, not for a whole tool";
    }
    return rule.tier === "ask"
      ? "Codex filesystem access is read, write or deny, never asked"
      : undefined;
  }
  return `Codex has no equivalent of a ${rule.tier} rule for ${rule.tool}${rule.tool === "Bash" ? "; command rules belong in its execpolicy rules files, which this codec does not write" : ""}`;
}

/**
 * Turn rules into Codex restrictions. A `deny` or `ask` rule Codex cannot enforce is recorded in
 * `unsupported` rather than dropped. An `allow` rule that cannot be represented is left out, which
 * can only make the result stricter; one carrying a condition is left out too, since applying it
 * unconditionally would widen it. `writesBlockedBySandbox` says the output already carries a
 * read-only sandbox, which covers a tool-wide write or edit deny.
 */
function codexRestrictions(
  rules: readonly Rule[],
  profile: string | undefined,
  writesBlockedBySandbox: boolean,
  unsupported: UnsupportedRule[],
): CodexRestrictions {
  const restrictions: CodexRestrictions = { filesystem: {}, domains: {} };
  for (const rule of rules) {
    if (rule.tier === "allow") {
      if (
        rule.when === undefined &&
        rule.tool === "WebFetch" &&
        rule.pattern?.startsWith(DOMAIN_PREFIX)
      ) {
        const domain = rule.pattern.slice(DOMAIN_PREFIX.length);
        restrictions.domains[domain] = strictestDomain(
          restrictions.domains[domain],
          "allow",
        );
      }
      continue;
    }
    const reason = codexRefusal(rule, writesBlockedBySandbox);
    if (reason !== undefined) {
      unsupported.push({
        rule,
        reason:
          profile === undefined
            ? reason
            : `${reason} (in profile "${profile}")`,
      });
      continue;
    }
    if (rule.tool === "WebFetch" && rule.pattern !== undefined) {
      const domain = rule.pattern.slice(DOMAIN_PREFIX.length);
      restrictions.domains[domain] = "deny";
    } else if (rule.pattern === undefined) {
      // A tool-wide write or edit deny, already carried by the read-only sandbox
    } else {
      restrictions.filesystem[rule.pattern] = strictestAccess(
        restrictions.filesystem[rule.pattern],
        rule.tool === "Read" ? "none" : "read",
      );
    }
  }
  return restrictions;
}

/** The tighter of two access modes for one path: none over read over write. */
function strictestAccess(
  a: CodexFilesystemAccess | undefined,
  b: CodexFilesystemAccess,
): CodexFilesystemAccess {
  if (a === "none" || b === "none") return "none";
  if (a === "read" || b === "read") return "read";
  return b;
}

/** The tighter of two domain actions: deny over allow. */
function strictestDomain(
  a: "allow" | "deny" | undefined,
  b: "allow" | "deny",
): "allow" | "deny" {
  return a === "deny" || b === "deny" ? "deny" : "allow";
}

function mergeFilesystem(
  a: Record<string, CodexFilesystemAccess>,
  b: Record<string, CodexFilesystemAccess>,
): Record<string, CodexFilesystemAccess> {
  const merged = { ...a };
  for (const [path, access] of Object.entries(b)) {
    merged[path] = strictestAccess(merged[path], access);
  }
  return merged;
}

function mergeDomains(
  a: Record<string, "allow" | "deny">,
  b: Record<string, "allow" | "deny">,
): Record<string, "allow" | "deny"> {
  const merged = { ...a };
  for (const [domain, action] of Object.entries(b)) {
    merged[domain] = strictestDomain(merged[domain], action);
  }
  return merged;
}

/** A Codex profile for the restrictions, with Codex's absolute paths and no empty sections. */
function codexProfileOf(restrictions: CodexRestrictions): CodexProfile {
  const profile: CodexProfile = {};
  const paths = Object.entries(restrictions.filesystem);
  if (paths.length > 0) {
    profile.filesystem = Object.fromEntries(
      paths.map(([path, access]) => [
        path.startsWith(".") ? path.slice(1) : path,
        access,
      ]),
    );
  }
  if (Object.keys(restrictions.domains).length > 0) {
    profile.network = { domains: restrictions.domains };
  }
  return profile;
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

    // --- Rules: represent every restrictive rule exactly, or refuse the conversion ---
    const unsupported: UnsupportedRule[] = [];
    const writesBlockedBySandbox = result.sandbox_mode === "read-only";
    const topLevel = codexRestrictions(
      collectRules(canonical),
      undefined,
      writesBlockedBySandbox,
      unsupported,
    );
    if (canonical.network?.domains) {
      for (const [domain, action] of Object.entries(
        canonical.network.domains,
      )) {
        topLevel.domains[domain] = strictestDomain(
          topLevel.domains[domain],
          action,
        );
      }
    }

    // --- profiles → named Codex profiles, each carrying the top-level restrictions ---
    const profiles: Record<string, CodexProfile> = {};
    for (const [name, profileTiers] of Object.entries(
      resolveProfiles(canonical.profiles),
    )) {
      const own = codexRestrictions(
        collectRules({ permissions: profileTiers }),
        name,
        writesBlockedBySandbox,
        unsupported,
      );
      profiles[name] = codexProfileOf({
        filesystem: mergeFilesystem(topLevel.filesystem, own.filesystem),
        domains: mergeDomains(topLevel.domains, own.domains),
      });
    }

    if (unsupported.length > 0) {
      throw new UnsupportedCapabilityError("codex", unsupported);
    }

    if (Object.keys(profiles).length > 0) {
      const named = Object.fromEntries(
        Object.entries(profiles).filter(
          ([, profile]) => Object.keys(profile).length > 0,
        ),
      );
      if (Object.keys(named).length > 0) {
        result.permissions = named;
        if (canonical.activeProfile) {
          result.default_permissions = canonical.activeProfile;
        }
      }
    } else {
      // No named profiles: one "default" profile holds the top-level restrictions
      const profile = codexProfileOf(topLevel);
      if (Object.keys(profile).length > 0) {
        result.permissions = { default: profile };
        result.default_permissions = "default";
      }
    }

    return result;
  },
});

// ---------------------------------------------------------------------------
// Oh My Pi (OMP) codec
// ---------------------------------------------------------------------------
// OMP keeps an ordered list of `bash.patterns` in its config.yml (global at ~/.omp/agent, and per
// project). Each entry is `{ match, approval }` with approval allow, prompt or deny.
//
// How OMP evaluates it (its bash tool, checked against its source):
//   - `match` is a glob where only `*` is special (it matches any run of characters); everything
//     else is literal, and there is no way to write a literal asterisk. Whitespace is collapsed in
//     the pattern and the command, and the match is anchored to the whole command.
//   - The first matching entry wins, in list order.
//   - deny and prompt entries apply to the whole command or to any one segment of a compound
//     command; an allow entry applies to a simple command only.
//
// Canonical rules use the strictest matching tier whatever their order, so the codec writes deny entries first, then prompt, then allow. Only rules for the bash tool are converted.
//
// OMP's `tools.approvalMode` decides calls no rule covers, by the tier each tool declares (read, write or exec): `always-ask` approves read and prompts for write and exec, `write` prompts for exec only, and `yolo`, its default, approves every tier. No mode prompts for a read and none denies, so a canonical mode that asks is written as `always-ask`, which leaves reads approved (the one gap), and `readonly` has no equivalent and is refused. A `bash.patterns` allow still wins under `always-ask`, as it does under a canonical mode that asks.

const OMP_APPROVALS = ["allow", "prompt", "deny"] as const;
const OmpPatternEntry = z.object({
  match: z.string(),
  approval: z.enum(OMP_APPROVALS),
});

/** OMP's approval modes, from the least to the most permissive. */
export const OMP_APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;

const ompNative = z.looseObject({
  bash: z.looseObject({ patterns: z.array(z.unknown()).optional() }).optional(),
  tools: z
    .looseObject({ approvalMode: z.enum(OMP_APPROVAL_MODES).optional() })
    .optional(),
});

/**
 * OMP approval mode to canonical mode, never looser than OMP: `write` approves writes without asking, which no canonical mode short of `autonomous` does, so it is read as `standard` like `always-ask`.
 */
const ompModeToCanonical = {
  "always-ask": "standard",
  write: "standard",
  yolo: "autonomous",
} as const;

/**
 * The OMP approval mode for a canonical mode, none when OMP's own mode is left alone, or the
 * refusal when OMP cannot enforce it. Aliases are read as the evaluator reads them.
 */
function ompApprovalMode(
  mode: PermissionMode,
): { mode?: "always-ask" } | { refused: UnsupportedSetting } {
  switch (mapMode(mode)) {
    case "autonomous":
      return {};
    case "readonly":
      return {
        refused: {
          setting: "defaultMode",
          value: mode,
          reason:
            "OMP has no mode that denies calls no rule covers, and none that prompts for a read",
        },
      };
    default:
      return { mode: "always-ask" };
  }
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

/** OMP collapses whitespace in patterns and commands before matching. */
function normaliseOmpText(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

/**
 * The OMP `match` globs that together match what a canonical pattern matches, or the reason OMP
 * cannot express it. A canonical prefix or trailing-wildcard pattern also matches the bare command,
 * so it is written twice: OMP's `git *` does not match `git`.
 */
function ompMatches(
  pattern: string | undefined,
): { matches: string[] } | { reason: string } {
  if (pattern === undefined) return { matches: ["*"] };

  const parsed = parseRulePattern(pattern);
  const literalStar = {
    reason: "OMP has no way to match a literal asterisk",
  };
  switch (parsed.type) {
    case "exact":
      return parsed.content.includes("*")
        ? literalStar
        : { matches: [parsed.content] };
    case "prefix":
      return parsed.prefix.includes("*")
        ? literalStar
        : { matches: [parsed.prefix, `${parsed.prefix} *`] };
    case "wildcard": {
      let glob = "";
      let stars = 0;
      const text = parsed.pattern;
      for (let i = 0; i < text.length; i++) {
        const c = text.charAt(i);
        const next = text.charAt(i + 1);
        if (c === "\\" && next === "*") return literalStar;
        if (c === "\\" && (next === "\\" || next === "(" || next === ")")) {
          glob += next;
          i += 1;
        } else {
          if (c === "*") stars += 1;
          glob += c;
        }
      }
      return glob.endsWith(" *") && stars === 1
        ? { matches: [glob.slice(0, -2), glob] }
        : { matches: [glob] };
    }
  }
}

/**
 * Canonical policy to OMP `bash.patterns`. A deny or ask that OMP cannot enforce as written is
 * refused; an allow it cannot express is left out, which is stricter.
 *
 * @throws UnsupportedCapabilityError listing the rules OMP cannot enforce.
 */
function encodeOmp(canonical: AgentPermissionPolicy): {
  bash?: {
    patterns: { match: string; approval: "allow" | "prompt" | "deny" }[];
  };
  tools?: { approvalMode: "always-ask" };
} {
  const unsupported: UnsupportedRule[] = [];
  const settings: UnsupportedSetting[] = [];
  const defaultMode =
    canonical.defaultMode ?? canonical.permissions?.defaultMode;
  const approvalMode =
    defaultMode === undefined ? {} : ompApprovalMode(defaultMode);
  if ("refused" in approvalMode) settings.push(approvalMode.refused);
  const byApproval: Record<"deny" | "prompt" | "allow", string[]> = {
    deny: [],
    prompt: [],
    allow: [],
  };

  for (const rule of agentRules(canonical, "omp")) {
    const approval = tierToOmpApproval[rule.tier];
    let reason: string | undefined;
    let matches: string[] = [];

    if (rule.tool.toLowerCase() !== "bash") {
      reason = "OMP applies bash.patterns to the bash tool only";
    } else if (rule.when !== undefined) {
      reason = "OMP cannot limit a rule with a condition";
    } else {
      const converted = ompMatches(rule.pattern);
      if ("reason" in converted) reason = converted.reason;
      else matches = converted.matches.map(normaliseOmpText);
      if (matches.some((match) => match === "")) {
        reason = "OMP ignores an empty pattern";
      }
    }

    if (reason !== undefined) {
      if (rule.tier !== "allow") unsupported.push({ rule, reason });
      continue;
    }
    for (const match of matches) {
      if (!byApproval[approval].includes(match)) {
        byApproval[approval].push(match);
      }
    }
  }

  if (unsupported.length > 0 || settings.length > 0) {
    throw new UnsupportedCapabilityError("omp", unsupported, settings);
  }

  // OMP takes the first matching entry, so the strictest tier goes first.
  const patterns = (["deny", "prompt", "allow"] as const).flatMap((approval) =>
    byApproval[approval].map((match) => ({ match, approval })),
  );
  return {
    ...(patterns.length > 0 && { bash: { patterns } }),
    ...("mode" in approvalMode && {
      tools: { approvalMode: approvalMode.mode },
    }),
  };
}

/**
 * OMP `bash.patterns` to canonical rules, in the order written. OMP takes the first match while a
 * canonical policy takes the strictest, so a broad allow written before a narrow deny is read as
 * the deny winning: never looser than OMP. An entry that cannot be read faithfully is an error, not
 * skipped, since skipping a deny would loosen the policy.
 */
function decodeOmp(native: z.infer<typeof ompNative>): AgentPermissionPolicy {
  const rules: Rule[] = [];
  for (const [index, raw] of (native.bash?.patterns ?? []).entries()) {
    const entry = OmpPatternEntry.parse(raw);
    const match = normaliseOmpText(entry.match);
    if (match === "") {
      throw new Error(`bash.patterns[${String(index)}] has an empty match`);
    }
    if (match.endsWith(":*")) {
      throw new Error(
        `bash.patterns[${String(index)}] ends in ":*", which the canonical pattern dialect reads as a prefix rule and OMP as a literal colon`,
      );
    }
    rules.push({
      tool: "Bash",
      pattern: match.replace(/\\/gu, "\\\\"),
      tier: ompApprovalToTier[entry.approval],
    });
  }
  const approvalMode = native.tools?.approvalMode;
  return {
    ...(approvalMode !== undefined && {
      defaultMode: ompModeToCanonical[approvalMode],
    }),
    ...(rules.length > 0 && { rules }),
  };
}

export const ompCodec = z.codec(ompNative, AgentPermissionPolicy, {
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
