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
  parseRulePattern,
  ruleToString,
  collectRules,
  mapMode,
} from "../evaluate.ts";
import { resolveProfiles } from "../profiles.ts";
import {
  UnsupportedCapabilityError,
  type UnsupportedRule,
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
 * rule or restrict everyone. Any other condition (a directory, a branch, an environment variable, a
 * remote) is dropped the same way an allow is, but a deny or ask keeps applying everywhere, which
 * is stricter. An ask that names approvers is refused too: written plain, anyone the agent's user
 * is could approve it. All refused rules are reported together.
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
      // No agent format holds any other condition either. Written without it, a deny or ask only
      // becomes stricter; an allow would apply everywhere, so it is left out.
      return rule.when === undefined || rule.tier !== "allow";
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

/**
 * The Claude Code mode for a canonical mode it has no name for, never looser than the original.
 * `readonly` refuses what no rule allows, which is what dontAsk does. `restricted` and `standard`
 * ask, which is default. `autonomous` writes none: Claude Code's own default asks, which is stricter.
 */
const claudeModeForCanonical: Partial<Record<string, "default" | "dontAsk">> = {
  readonly: "dontAsk",
  restricted: "default",
  standard: "default",
};

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
        const match =
          claudeCodeModes.find((m) => m === ccDefaultMode) ??
          claudeModeForCanonical[ccDefaultMode];
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
const OC_STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const;

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
    const unsupported: UnsupportedRule[] = [];

    for (const rule of allRules) {
      const ocTool = canonicalToOc[rule.tool];
      if (!ocTool) {
        if (rule.tier !== "allow") {
          unsupported.push({
            rule,
            reason: `OpenCode has no permission setting for ${rule.tool}`,
          });
        }
        continue;
      }

      const pattern = rule.pattern ? rule.pattern.replace(/:\*$/, " *") : "*";

      let toolRules = result[ocTool];
      if (!toolRules) {
        toolRules = {};
        result[ocTool] = toolRules;
      }
      // Two rules on one pattern collapse to the stricter, whatever order they came in.
      const existing = toolRules[pattern];
      toolRules[pattern] =
        existing === undefined ||
        OC_STRICTNESS[rule.tier] > OC_STRICTNESS[existing]
          ? rule.tier
          : existing;
    }
    if (unsupported.length > 0) {
      throw new UnsupportedCapabilityError("opencode", unsupported);
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
    const unsupported: UnsupportedRule[] = [];
    for (const rule of allRules) {
      // Crush has an allowlist of tools and nothing else: no deny, no ask, no patterns. A deny or
      // ask is refused, and an allow it cannot express is left out, which is stricter.
      if (rule.tier !== "allow") {
        unsupported.push({
          rule,
          reason: "Crush has only an allowlist of tools: no deny, no ask",
        });
        continue;
      }
      if (rule.pattern !== undefined) continue;
      const crushTool = canonicalToCrush[rule.tool];
      if (crushTool) allowed.push(crushTool);
    }
    if (unsupported.length > 0) {
      throw new UnsupportedCapabilityError("crush", unsupported);
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
    const unsupported: UnsupportedRule[] = [];
    const shellSettings: NonNullable<KiroNative["toolsSettings"]>["shell"] = {};
    const readSettings: NonNullable<KiroNative["toolsSettings"]>["read"] = {};
    const writeSettings: NonNullable<KiroNative["toolsSettings"]>["write"] = {};
    const awsSettings: NonNullable<KiroNative["toolsSettings"]>["aws"] = {};
    const webFetchSettings: NonNullable<
      KiroNative["toolsSettings"]
    >["web_fetch"] = {};

    for (const rule of allRules) {
      const kiroTool = canonicalToKiro[rule.tool];
      let written = false;

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
          written = true;
        } else if (rule.tier === "allow") {
          shellSettings.allowedCommands ??= [];
          shellSettings.allowedCommands.push(addKiroAnchors(rule.pattern));
          written = true;
        }
      } else if (rule.tool === "Read" && rule.pattern !== undefined) {
        if (rule.tier === "deny") {
          readSettings.deniedPaths ??= [];
          readSettings.deniedPaths.push(rule.pattern);
          written = true;
        } else if (rule.tier === "allow") {
          readSettings.allowedPaths ??= [];
          readSettings.allowedPaths.push(rule.pattern);
          written = true;
        }
      } else if (rule.tool === "Write" && rule.pattern !== undefined) {
        if (rule.tier === "deny") {
          writeSettings.deniedPaths ??= [];
          writeSettings.deniedPaths.push(rule.pattern);
          written = true;
        } else if (rule.tier === "allow") {
          writeSettings.allowedPaths ??= [];
          writeSettings.allowedPaths.push(rule.pattern);
          written = true;
        }
      } else if (rule.tool === "Aws" && rule.pattern?.startsWith("service:")) {
        const svc = rule.pattern.slice("service:".length);
        if (rule.tier === "deny") {
          awsSettings.deniedServices ??= [];
          awsSettings.deniedServices.push(svc);
          written = true;
        } else if (rule.tier === "allow") {
          awsSettings.allowedServices ??= [];
          awsSettings.allowedServices.push(svc);
          written = true;
        }
      } else if (rule.tool === "WebFetch" && rule.pattern?.startsWith("url:")) {
        const urlPattern = rule.pattern.slice("url:".length);
        if (rule.tier === "deny") {
          webFetchSettings.blocked ??= [];
          webFetchSettings.blocked.push(addKiroAnchors(urlPattern));
          written = true;
        } else if (rule.tier === "allow") {
          webFetchSettings.trusted ??= [];
          webFetchSettings.trusted.push(addKiroAnchors(urlPattern));
          written = true;
        }
      }
      // A deny or ask with nowhere to go in Kiro's settings is refused, not dropped.
      if (!written && rule.tier !== "allow") {
        unsupported.push({
          rule,
          reason: `Kiro has no setting for a ${rule.tier} on ${rule.tool}${rule.pattern === undefined ? "" : ` matching ${rule.pattern}`}`,
        });
      }
    }

    if (unsupported.length > 0) {
      throw new UnsupportedCapabilityError("kiro", unsupported);
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
// permissions.<name>.filesystem → deny rules with Read/Write/Edit patterns permissions.<name>.network.domains → network.domains + WebFetch rules named profiles → profiles record + activeProfile
//
// Filesystem keys (Codex's `permissions_toml.rs` and `config/permissions.rs`): a key is an absolute path, `~/...`, or a special root such as `:root`, `:minimal`, `:tmpdir` or `:workspace_roots`. A key takes an access value (`read`, `write` or `deny`, with `none` read as a legacy alias of `deny`) or a table of descendant subpaths, and `:workspace_roots` is always given as such a table, with `.` for each root itself. An entry covers its path and everything under it, and the more specific of two entries wins. Codex reads `*`, `?`, `[` and `]` as glob syntax, supported only for `deny`.
//
// A canonical `./path` is relative to the working directory, so it becomes a subpath of `:workspace_roots`; an absolute path stays an absolute key. Both cover the whole subtree, and the workspace roots include any Codex adds beyond the working directory, so a written entry is never narrower than the rule it came from. A trailing `/*` or `/**` is that same subtree. Every other pattern (a wildcard elsewhere, a string prefix, `~`, a bare relative path, `.` or `..` segments, a character Codex would read as glob syntax) has no faithful Codex form and is refused.

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

/** One Codex filesystem entry: an access value, or a table of descendant subpaths under its key. */
const codexFilesystemEntry = z.union([
  CodexFilesystemAccess,
  z.record(z.string(), CodexFilesystemAccess),
]);

type CodexFilesystemEntry = z.infer<typeof codexFilesystemEntry>;

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
        // { "/abs/path": "deny", ":workspace_roots": { ".": "write", "secrets": "deny" } }
        filesystem: z.record(z.string(), codexFilesystemEntry).optional(),
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
  filesystem?: Record<string, CodexFilesystemEntry> | undefined;
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
  // mapMode names what each mode does to a call no rule covers; dontAsk refuses it, so it is never "never"
  const mapped = mapMode(mode ?? "standard");
  if (mapped === "autonomous") return "never";
  if (mapped === "restricted" || mapped === "readonly") return "untrusted";
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

/** The Codex special root whose subpaths are relative to each workspace root. */
const WORKSPACE_ROOTS = ":workspace_roots";

/** Codex's earlier name for `:workspace_roots`, which it still reads. */
const PROJECT_ROOTS = ":project_roots";

/** The characters Codex reads as glob syntax in a filesystem key or subpath. */
const CODEX_GLOB = /[*?[\]]/;

/** The canonical pattern for everything under a path, given the path's own pattern. */
function subtreePattern(location: string): string {
  return location === "/" ? "/**" : `${location}/**`;
}

/**
 * A literal path as a canonical exact pattern. Exact patterns give a backslash escape meaning, so each is doubled; a path reaching here carries no `*`, which Codex would have read as glob syntax.
 */
function literalPattern(path: string): string {
  return path.replaceAll("\\", "\\\\");
}

/**
 * Map Codex filesystem entries to canonical deny rules. An entry covers its path and everything under it, so each becomes a rule on the path and one on its subtree. A `write` entry restricts nothing and adds no rule.
 *
 * @throws Error on a `read` or `deny` entry whose location has no canonical form: a special root other than `:workspace_roots`, a `~` path, or glob syntax. Leaving it out would drop a restriction.
 */
function codexFilesystemToRules(
  fs: Record<string, CodexFilesystemEntry>,
  rules: Rule[],
): void {
  for (const [key, entry] of Object.entries(fs)) {
    const table = typeof entry === "string" ? { ".": entry } : entry;
    for (const [subpath, access] of Object.entries(table)) {
      if (access === "write") continue;
      const location = canonicalLocation(key, subpath);
      if (location === undefined) {
        const where = subpath === "." ? key : `${key} ${subpath}`;
        throw new Error(
          `Codex filesystem entry ${where} = "${access}" has no canonical path: only absolute paths and :workspace_roots subpaths without glob syntax convert`,
        );
      }
      const tools =
        access === "read" ? ["Write", "Edit"] : ["Read", "Write", "Edit"];
      for (const tool of tools) {
        rules.push(
          { tool, pattern: literalPattern(location), tier: "deny" },
          {
            tool,
            pattern: subtreePattern(literalPattern(location)),
            tier: "deny",
          },
        );
      }
    }
  }
}

/** The canonical path for a Codex key and one of its subpaths (`.` for the key itself), or `undefined`. */
function canonicalLocation(key: string, subpath: string): string | undefined {
  if (CODEX_GLOB.test(key) || CODEX_GLOB.test(subpath)) return undefined;
  const base =
    key === WORKSPACE_ROOTS || key === PROJECT_ROOTS
      ? "."
      : key.startsWith("/")
        ? key
        : undefined;
  if (base === undefined || subpath === ".") return base;
  return base.endsWith("/") ? `${base}${subpath}` : `${base}/${subpath}`;
}

/** The file and network restrictions a set of rules puts on a Codex profile. */
interface CodexRestrictions {
  /** Absolute filesystem keys. */
  absolute: Record<string, CodexRestriction>;
  /** Subpaths of `:workspace_roots`, with `.` for the roots themselves. */
  workspace: Record<string, CodexRestriction>;
  domains: Record<string, "allow" | "deny">;
  /** Execpolicy prefix rules, keyed by their space-joined words. */
  commands: Record<string, CodexCommandRule>;
}

/** The two filesystem access values a restrictive rule becomes: `read` blocks writes, `deny` blocks everything. */
type CodexRestriction = "read" | "deny";

/** Where a canonical path rule lands in Codex, or why it cannot. */
type CodexPathLocation =
  | { kind: "absolute" | "workspace"; path: string }
  | { kind: "refused"; reason: string };

function refusedPath(reason: string): CodexPathLocation {
  return { kind: "refused", reason };
}

/** Whether a path is one or more segments, none of them empty, `.` or `..`. */
function isDescendantPath(path: string): boolean {
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Where Codex protects the paths a canonical file pattern names. An exact path and a trailing `/*` or `/**` map to the path's subtree, which is never narrower; anything else is refused.
 */
function codexPathLocation(pattern: string): CodexPathLocation {
  const parsed = parseRulePattern(pattern);
  let path: string;
  if (parsed.type === "exact") {
    path = parsed.content;
  } else if (parsed.type === "prefix") {
    return refusedPath("Codex matches a whole path, not a string prefix");
  } else {
    const base = /^(.*)\/\*\*?$/.exec(parsed.pattern)?.[1];
    const baseParsed = base === undefined ? undefined : parseRulePattern(base);
    if (baseParsed?.type !== "exact") {
      return refusedPath(
        "Codex matches a path and everything under it, not a wildcard elsewhere in the path",
      );
    }
    path = baseParsed.content === "" ? "/" : baseParsed.content;
  }
  if (CODEX_GLOB.test(path)) {
    return refusedPath("Codex reads *, ?, [ and ] in a path as glob syntax");
  }
  if (path === "." || path === "./") return { kind: "workspace", path: "." };
  if (path.startsWith("./")) {
    const subpath = path.slice(2).replace(/\/$/, "");
    return isDescendantPath(subpath)
      ? { kind: "workspace", path: subpath }
      : refusedPath(
          "Codex takes a workspace path only as a descendant with no empty, . or .. segments",
        );
  }
  if (path === "/") return { kind: "absolute", path };
  if (path.startsWith("/")) {
    const absolute = path.replace(/\/$/, "");
    return isDescendantPath(absolute.slice(1))
      ? { kind: "absolute", path: absolute }
      : refusedPath(
          "Codex takes an absolute path only with no empty, . or .. segments",
        );
  }
  return refusedPath(
    "Codex takes an absolute path or a ./ path under the workspace roots",
  );
}

const FILE_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit"]);
const DOMAIN_PREFIX = "domain:";

/** Why Codex cannot enforce a restrictive rule as written, or `undefined` when it can. */
function codexRefusal(
  rule: Rule,
  writesBlockedBySandbox: boolean,
  commandScope: CommandRuleScope,
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
    // Whether Codex can place the path is codexPathLocation's to decide
    return rule.tier === "ask"
      ? "Codex filesystem access is read, write or deny, never asked"
      : undefined;
  }
  if (rule.tool === "Bash") {
    if (commandScope === "config-only") {
      return "Codex enforces command rules through execpolicy rules files, which only encodeCodex writes";
    }
    if (commandScope === "profile") {
      return "Codex execpolicy rules apply to every profile, not to one named profile";
    }
    // Whether Codex can match the command exactly is codexCommandPrefix's to decide
    return rule.pattern === undefined
      ? "Codex prefix rules match a command, not the whole tool"
      : undefined;
  }
  return `Codex has no equivalent of a ${rule.tier} rule for ${rule.tool}`;
}

/**
 * Where a command rule can go. `config-only` is the config codec on its own, which cannot hold one; `rules-file` is the top level under `encodeCodex`, which writes an execpolicy rules file; `profile` is a named profile under `encodeCodex`, whose command rules a rules file would apply to every profile.
 */
type CommandRuleScope = "config-only" | "rules-file" | "profile";

/** The execpolicy decision a restrictive command rule becomes. */
type CodexCommandDecision = "forbidden" | "prompt";

/** One execpolicy prefix rule: the leading words a command must start with, and the decision. */
interface CodexCommandRule {
  words: string[];
  decision: CodexCommandDecision;
}

/**
 * A word Codex tokenises exactly as the policy spells it: no quoting, escapes, globbing, expansion or shell operators, so the shell word and the literal text agree.
 */
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/**
 * The words of an execpolicy prefix rule matching exactly the commands a canonical command pattern matches, or why there is none. A `prefix:*` pattern and a pattern whose only wildcard is a trailing ` *` both match the words alone or followed by a space and anything, which is what a prefix rule matches once Codex has split the command into words.
 */
function codexCommandPrefix(
  pattern: string,
): { words: string[] } | { reason: string } {
  const parsed = parseRulePattern(pattern);
  let prefix: string;
  if (parsed.type === "prefix") {
    prefix = parsed.prefix;
  } else if (parsed.type === "wildcard") {
    const base = /^(.*) \*$/.exec(parsed.pattern)?.[1];
    const baseParsed = base === undefined ? undefined : parseRulePattern(base);
    if (baseParsed?.type !== "exact") {
      return {
        reason:
          "Codex prefix rules match leading words, not a wildcard elsewhere in the command",
      };
    }
    prefix = baseParsed.content;
  } else {
    return {
      reason:
        "Codex prefix rules match a command with any arguments, not one exact command",
    };
  }
  const words = prefix.split(" ");
  if (!words.every((word) => PLAIN_WORD.test(word))) {
    return {
      reason:
        "Codex splits a command into shell words, so the prefix must be plain words separated by single spaces, with no quoting or shell syntax",
    };
  }
  if (words[0]?.includes("=")) {
    return {
      reason:
        "Codex does not split a command that starts with a variable assignment into words",
    };
  }
  return { words };
}

/** The tighter of two command decisions: forbidden over prompt. */
function strictestDecision(
  a: CodexCommandDecision | undefined,
  b: CodexCommandDecision,
): CodexCommandDecision {
  return a === "forbidden" || b === "forbidden" ? "forbidden" : "prompt";
}

/**
 * Turn rules into Codex restrictions. A `deny` or `ask` rule Codex cannot enforce is recorded in `unsupported` rather than dropped. An `allow` rule that cannot be represented is left out, which can only make the result stricter; one carrying a condition is left out too, since applying it unconditionally would widen it. `writesBlockedBySandbox` says the output already carries a read-only sandbox, which covers a tool-wide write or edit deny.
 */
function codexRestrictions(
  rules: readonly Rule[],
  profile: string | undefined,
  writesBlockedBySandbox: boolean,
  commandScope: CommandRuleScope,
  unsupported: UnsupportedRule[],
): CodexRestrictions {
  const restrictions: CodexRestrictions = {
    absolute: {},
    workspace: {},
    domains: {},
    commands: {},
  };
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
    const refuse = (reason: string): void => {
      unsupported.push({
        rule,
        reason:
          profile === undefined
            ? reason
            : `${reason} (in profile "${profile}")`,
      });
    };
    const reason = codexRefusal(rule, writesBlockedBySandbox, commandScope);
    if (reason !== undefined) {
      refuse(reason);
      continue;
    }
    if (rule.tool === "Bash" && rule.pattern !== undefined) {
      const prefix = codexCommandPrefix(rule.pattern);
      if ("reason" in prefix) {
        refuse(prefix.reason);
        continue;
      }
      const key = prefix.words.join(" ");
      restrictions.commands[key] = {
        words: prefix.words,
        decision: strictestDecision(
          restrictions.commands[key]?.decision,
          rule.tier === "deny" ? "forbidden" : "prompt",
        ),
      };
    } else if (rule.tool === "WebFetch" && rule.pattern !== undefined) {
      const domain = rule.pattern.slice(DOMAIN_PREFIX.length);
      restrictions.domains[domain] = "deny";
    } else if (rule.pattern === undefined) {
      // A tool-wide write or edit deny, already carried by the read-only sandbox
    } else {
      const location = codexPathLocation(rule.pattern);
      if (location.kind === "refused") {
        refuse(location.reason);
        continue;
      }
      const table =
        location.kind === "absolute"
          ? restrictions.absolute
          : restrictions.workspace;
      table[location.path] = strictestAccess(
        table[location.path],
        rule.tool === "Read" ? "deny" : "read",
      );
    }
  }
  return restrictions;
}

/** The tighter of two restrictions on one path: deny over read. */
function strictestAccess(
  a: CodexRestriction | undefined,
  b: CodexRestriction,
): CodexRestriction {
  return a === "deny" || b === "deny" ? "deny" : "read";
}

/** The tighter of two domain actions: deny over allow. */
function strictestDomain(
  a: "allow" | "deny" | undefined,
  b: "allow" | "deny",
): "allow" | "deny" {
  return a === "deny" || b === "deny" ? "deny" : "allow";
}

function mergeAccess(
  a: Record<string, CodexRestriction>,
  b: Record<string, CodexRestriction>,
): Record<string, CodexRestriction> {
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

/** Whether `ancestor` is a strict ancestor of `path` in one filesystem table, where `.` and `/` are roots. */
function isAncestorPath(ancestor: string, path: string): boolean {
  if (ancestor === path) return false;
  if (ancestor === "." || ancestor === "/") return true;
  return path.startsWith(`${ancestor}/`);
}

/**
 * The table with each path at least as strict as every ancestor in it. Codex lets the more specific of two entries win, so a nested `read` under a `deny` would reopen part of a subtree the rules deny.
 */
function inheritAncestors(
  table: Record<string, CodexRestriction>,
): Record<string, CodexRestriction> {
  return Object.fromEntries(
    Object.entries(table).map(([path, access]) => [
      path,
      Object.entries(table).reduce(
        (strictest, [ancestor, inherited]) =>
          isAncestorPath(ancestor, path)
            ? strictestAccess(strictest, inherited)
            : strictest,
        access,
      ),
    ]),
  );
}

/** A Codex profile for the restrictions, with no empty sections. */
function codexProfileOf(restrictions: CodexRestrictions): CodexProfile {
  const profile: CodexProfile = {};
  const filesystem: Record<string, CodexFilesystemEntry> = inheritAncestors(
    restrictions.absolute,
  );
  if (Object.keys(restrictions.workspace).length > 0) {
    filesystem[WORKSPACE_ROOTS] = inheritAncestors(restrictions.workspace);
  }
  if (Object.keys(filesystem).length > 0) {
    profile.filesystem = filesystem;
  }
  if (Object.keys(restrictions.domains).length > 0) {
    profile.network = { domains: restrictions.domains };
  }
  return profile;
}

/**
 * Encode a canonical policy for Codex: the config object and the execpolicy prefix rules for its command rules, which only the `rules-file` scope collects.
 *
 * @throws UnsupportedCapabilityError listing every restrictive rule Codex cannot enforce exactly.
 */
function codexEncoding(
  canonical: AgentPermissionPolicy,
  commandScope: "config-only" | "rules-file",
): { config: Partial<CodexNative>; commands: CodexCommandRule[] } {
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
    if (mapMode(canonical.defaultMode) === "readonly") {
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
    commandScope,
    unsupported,
  );
  if (canonical.network?.domains) {
    for (const [domain, action] of Object.entries(canonical.network.domains)) {
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
      commandScope === "config-only" ? "config-only" : "profile",
      unsupported,
    );
    profiles[name] = codexProfileOf({
      absolute: mergeAccess(topLevel.absolute, own.absolute),
      workspace: mergeAccess(topLevel.workspace, own.workspace),
      domains: mergeDomains(topLevel.domains, own.domains),
      commands: {},
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

  return { config: result, commands: Object.values(topLevel.commands) };
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
    return codexEncoding(canonical, "config-only").config;
  },
});

/**
 * Where the execpolicy rules file goes, relative to the directory holding Codex's config. Codex loads every `*.rules` file in the `rules` directory of each config layer (`~/.codex/rules`, a project's `.codex/rules`).
 */
export const CODEX_EXECPOLICY_RULES_PATH = "rules/agent-perms.rules";

/**
 * A canonical policy encoded for Codex: the config object, and the content of an execpolicy rules file when the policy has command rules.
 */
export interface CodexEncoding {
  config: z.input<typeof codexNative>;
  /** Starlark `prefix_rule` calls for {@link CODEX_EXECPOLICY_RULES_PATH}, or `undefined` when there are none. */
  rules: string | undefined;
}

/**
 * Encode a canonical policy for Codex, writing its top-level command `deny` and `ask` rules as execpolicy prefix rules (`forbidden` and `prompt`) instead of refusing them. Only a `prefix:*` pattern, or one whose sole wildcard is a trailing ` *`, made of plain words, is written; a command `allow` is left out, which is stricter.
 *
 * @throws UnsupportedCapabilityError listing every restrictive rule Codex cannot enforce exactly, including a command rule in a named profile, since a rules file applies to every profile.
 */
export function encodeCodex(canonical: AgentPermissionPolicy): CodexEncoding {
  const { config, commands } = codexEncoding(canonical, "rules-file");
  if (commands.length === 0) return { config, rules: undefined };
  const lines = commands.map(
    ({ words, decision }) =>
      `prefix_rule(pattern = [${words.map((word) => JSON.stringify(word)).join(", ")}], decision = "${decision}")\n`,
  );
  return {
    config,
    rules: `# Generated by agent-perms from a canonical permission policy.\n${lines.join("")}`,
  };
}

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
// Canonical rules use the strictest matching tier whatever their order, so the codec writes deny
// entries first, then prompt, then allow. OMP's default approval mode, its other tools and its
// settings are not converted: only rules for the bash tool are.

const OMP_APPROVALS = ["allow", "prompt", "deny"] as const;
const OmpPatternEntry = z.object({
  match: z.string(),
  approval: z.enum(OMP_APPROVALS),
});

const ompNative = z.looseObject({
  bash: z.looseObject({ patterns: z.array(z.unknown()).optional() }).optional(),
});

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
} {
  const unsupported: UnsupportedRule[] = [];
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

  if (unsupported.length > 0) {
    throw new UnsupportedCapabilityError("omp", unsupported);
  }

  // OMP takes the first matching entry, so the strictest tier goes first.
  const patterns = (["deny", "prompt", "allow"] as const).flatMap((approval) =>
    byApproval[approval].map((match) => ({ match, approval })),
  );
  return patterns.length === 0 ? {} : { bash: { patterns } };
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
  return rules.length === 0 ? {} : { rules };
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
