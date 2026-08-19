/**
 * Agent Permission Policy — Zod schema (source of truth).
 *
 * This file defines `.agents/permissions.json` and
 * `.agents/permissions.local.json`. The compiled JSON Schema
 * (`agent-permissions.schema.json`) is generated via `z.toJSONSchema()`
 * and submitted to SchemaStore for IDE autocomplete/validation.
 *
 * Compile: pnpm build:schema
 */

import * as z from "zod";

// ---------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------

/**
 * Default permission mode when starting an agent session.
 *
 * Agent Permission Policy modes:
 * - `standard`: Prompt for unsafe operations (default)
 * - `autonomous`: Auto-approve unless deny/ask rules match
 * - `restricted`: Prompt for all operations
 * - `readonly`: Only allow read-only tools
 *
 * Claude Code compatible modes (accepted for zero-translation migration):
 * - `plan`: Plan-only mode (maps to `restricted`)
 * - `dontAsk`: Auto-approve (maps to `autonomous`)
 * - `acceptEdits`: Accept edits without prompt (maps to `standard`)
 * - `bypassPermissions`: Bypass all permission checks (maps to `autonomous`)
 * - `default`: Agent default behaviour (maps to `standard`)
 *
 * **Security note**: `autonomous`, `bypassPermissions`, and `dontAsk` are only
 * trusted from personal (`permissions.local.json`) or managed (enterprise)
 * sources — NOT from committed `permissions.json`.
 */
export const PermissionMode = z
  .enum([
    // APP modes
    "standard",
    "autonomous",
    "restricted",
    "readonly",
    // Claude Code compatible modes
    "plan",
    "dontAsk",
    "acceptEdits",
    "bypassPermissions",
    "default",
    "auto",
  ])
  .meta({
    description:
      "Default permission mode. Agent Permission Policy modes: standard, autonomous, restricted, readonly. " +
      "Claude Code compatible modes: plan, dontAsk, acceptEdits, bypassPermissions, default.",
    default: "standard",
  });

// ---------------------------------------------------------------------------
// Permission rule pattern
// ---------------------------------------------------------------------------

/**
 * A permission rule string.
 *
 * Syntax (compatible with Claude Code's permission rule format):
 *
 * | Pattern                        | Matches                              |
 * |-------------------------------|--------------------------------------|
 * | `Tool`                        | All invocations of the tool          |
 * | `Tool(exact command)`          | Exactly that command                 |
 * | `Tool(prefix:*)`              | Commands starting with `prefix `     |
 * | `Tool(*suffix)`               | Commands ending with ` suffix`       |
 * | `Tool(pattern * middle *)`    | Commands containing both substrings  |
 * | `Read(./path)`                | File reads at that relative path     |
 * | `Read(./path/**)`             | File reads under that path (glob)    |
 * | `WebFetch(domain:example.com)`| Fetches to that domain               |
 * | `mcp__server`                 | All tools from an MCP server         |
 * | `mcp__server__tool`           | A specific MCP tool                  |
 */
export const PermissionRule = z.string();

// ---------------------------------------------------------------------------
// Permission tier lists
// ---------------------------------------------------------------------------

export const PermissionTiers = z
  .object({
    /**
     * Tools auto-approved without prompting.
     * Evaluated after deny rules — if a deny matches, allow is never checked.
     */
    allow: z.array(PermissionRule).meta({
      description:
        "Tools auto-approved without prompting. Evaluated after deny rules.",
      examples: ["Bash(git status)", "Bash(npm run test:*)", "Read", "Grep"],
    }),

    /**
     * Tools always denied — short-circuits before allow and ask.
     * Deny rules from ALL sources are merged and checked first.
     * A deny cannot be overridden by an allow in any other source.
     */
    deny: z.array(PermissionRule).meta({
      description:
        "Tools always denied — short-circuits before allow and ask. A deny cannot be overridden by an allow in any other source.",
      examples: ["Bash(sudo:*)", "Bash(rm -rf /)", "Read(./.env)"],
    }),

    /**
     * Tools that always prompt, even in autonomous mode.
     * Evaluated after deny but before allow.
     */
    ask: z.array(PermissionRule).meta({
      description:
        "Tools that always prompt, even in autonomous mode. Evaluated after deny but before allow.",
      examples: ["Bash(git push:*)", "Bash(npm publish:*)"],
    }),

    /**
     * Directories beyond project root that agents may access.
     * Paths are relative to project root or absolute.
     */
    additionalDirectories: z.array(z.string()).meta({
      description: "Directories beyond project root that agents may access.",
      examples: ["../shared-libs/", "/tmp/build-cache"],
    }),

    /**
     * Default permission mode. Also accepted at the top level.
     * Included here for Claude Code compatibility — Claude Code places
     * defaultMode inside the permissions object.
     */
    defaultMode: PermissionMode.meta({
      description:
        "Default permission mode. Accepted here for Claude Code compatibility, " +
        "or at the top level for the canonical placement.",
    }),
  })
  .partial()
  .strict();

// ---------------------------------------------------------------------------
// Conditional rules
// ---------------------------------------------------------------------------

export const RuleCondition = z
  .object({
    /** Working directory pattern (glob). */
    cwd: z.string().meta({ description: "Working directory pattern (glob)." }),

    /** Git branch name pattern (glob). */
    branch: z.string().meta({ description: "Git branch name pattern (glob)." }),
  })
  .partial();

export const Rule = z
  .object({
    /** Canonical tool name (e.g. "Bash", "Read", "Write"). */
    tool: z.string().meta({
      description: "Canonical tool name.",
      examples: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Grep",
        "WebFetch",
        "Agent",
        "mcp__github__create_issue",
      ],
    }),

    /**
     * Pattern to match against tool input. Same syntax as permission rules.
     * When absent, matches any input for the tool (bare tool rule).
     */
    pattern: z
      .string()
      .optional()
      .meta({
        description:
          "Pattern to match against tool input. When absent, matches any input.",
        examples: ["npm run *", "./config/**", "git push --force:*"],
      }),

    /** Permission tier to apply when this rule matches. */
    tier: z.enum(["allow", "deny", "ask"]).meta({
      description: "Permission tier to apply when this rule matches.",
    }),

    /** Optional conditions. All must match for the rule to apply (AND logic). */
    when: RuleCondition.optional().meta({
      description:
        "Optional conditions. All must match for the rule to apply (AND logic).",
    }),
  })
  .meta({
    description:
      "Permission rule. Evaluated deny-first: all deny rules, then ask, then allow.",
  });

// ---------------------------------------------------------------------------
// Delegation controls
// ---------------------------------------------------------------------------

export const Delegation = z
  .object({
    /**
     * Maximum depth of agent nesting. 0 = no subagents allowed.
     * @default 2
     */
    maxDepth: z.number().int().min(0).meta({
      description: "Maximum depth of agent nesting. 0 = no subagents allowed.",
      default: 2,
    }),

    /**
     * Tools that cannot be delegated to subagents.
     * Uses the same permission rule syntax.
     */
    nonDelegable: z.array(PermissionRule).meta({
      description:
        "Tools that cannot be delegated to subagents. Uses the same rule syntax.",
      examples: ["Bash(sudo:*)", "Write(./.agents/**)"],
    }),

    /**
     * Whether subagents can request elevated permissions from their parent.
     * @default true
     */
    bubbleUp: z.boolean().meta({
      description:
        "Whether subagents can request elevated permissions from their parent.",
      default: true,
    }),

    /**
     * Per-agent permission overrides. Keys are agent names or glob patterns
     * matching agent identifiers. Values are inline permission tiers that
     * replace (not merge with) the parent policy for that agent.
     *
     * Maps to OpenCode's per-agent markdown frontmatter and Codex's
     * `apps.<name>.tools` config.
     */
    agents: z.record(z.string(), PermissionTiers).meta({
      description:
        "Per-agent permission overrides. Keys are agent names or glob patterns. " +
        "Values replace (not merge with) the parent policy for that agent.",
      examples: [
        {
          review: { deny: ["Write", "Edit", "Bash"], allow: ["Read", "Grep"] },
          docs: { allow: ["Read", "Write(./docs/**)", "Bash(mdbook build:*)"] },
        },
      ],
    }),
  })
  .partial();

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sandbox configuration
// ---------------------------------------------------------------------------

/**
 * Sandbox mode — OS-level isolation for agent tool execution.
 *
 * When set, the agent harness should enforce filesystem and network
 * boundaries at the OS level (sandbox, container, namespace, etc).
 * This is orthogonal to permission rules — rules control what the agent
 * *asks* to do; sandbox controls what the OS *allows* it to do.
 *
 * Maps to Codex's `sandbox_mode` field.
 */
export const SandboxMode = z
  .enum(["readonly", "workspace-write", "full-access"])
  .meta({
    description:
      "OS-level sandbox isolation mode. " +
      "readonly: filesystem is read-only. " +
      "workspace-write: writes confined to project directory + writableRoots. " +
      "full-access: no OS-level restrictions.",
    default: "workspace-write",
  });

export const Sandbox = z
  .object({
    /**
     * Sandbox isolation mode.
     */
    mode: SandboxMode.meta({
      description: "Sandbox isolation mode.",
    }),

    /**
     * Additional paths the agent may write to (beyond project root).
     * Only meaningful when mode is `workspace-write`.
     */
    writableRoots: z.array(z.string()).meta({
      description:
        "Additional paths the agent may write to (beyond project root). " +
        "Only meaningful when mode is `workspace-write`.",
      examples: ["/tmp/build-cache", "../shared-libs"],
    }),

    /**
     * Whether the agent may make network requests from within the sandbox.
     * When false, network access is blocked at the OS level.
     * Maps to Codex's `sandbox_workspace_write.network_access`.
     */
    networkAccess: z.boolean().meta({
      description:
        "Whether the agent may make network requests from within the sandbox. " +
        "When false, network access is blocked at the OS level.",
      default: true,
    }),
  })
  .partial()
  .strict()
  .meta({
    description:
      "OS-level sandbox configuration. Controls filesystem and network " +
      "isolation for agent tool execution, enforced by the harness runtime.",
  });

// ---------------------------------------------------------------------------
// Named profiles
// ---------------------------------------------------------------------------

/**
 * Named permission profiles that can be selected at session start.
 *
 * Maps to Codex's `permissions.<name>` + `default_permissions` fields.
 * Agents that don't support named profiles should use the profile
 * specified by `activeProfile` (or `"default"` if unset).
 */
export const Profiles = z.record(z.string(), PermissionTiers).meta({
  description:
    "Named permission profiles. Each profile is a complete set of permission tiers. " +
    "Select one at session start via `activeProfile`.",
  examples: [
    {
      strict: { deny: ["Write", "Edit", "Bash"], allow: ["Read", "Grep"] },
      relaxed: {
        allow: ["Read", "Write", "Edit", "Bash(git:*)", "Bash(npm:*)"],
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// Network controls
// ---------------------------------------------------------------------------

export const Network = z
  .object({
    /**
     * Whether network access is permitted at all.
     * When false, WebFetch and WebSearch are denied regardless of allow rules.
     */
    enabled: z.boolean().meta({
      description:
        "Whether network access is permitted at all. When false, " +
        "WebFetch and WebSearch are denied regardless of allow rules.",
      default: true,
    }),

    /**
     * Domain-level allow/deny rules for HTTP(S) requests.
     * Maps to both Codex's `network.domains` and Claude Code's
     * `WebFetch(domain:...)` rules.
     */
    domains: z.record(z.string(), z.enum(["allow", "deny"])).meta({
      description:
        "Domain-level allow/deny rules for HTTP(S) requests. " +
        "Supplements the WebFetch(domain:...) permission rules.",
      examples: [{ "api.example.com": "allow", "evil.com": "deny" }],
    }),
  })
  .partial()
  .strict()
  .meta({
    description: "Network access controls.",
  });

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

export const AgentPermissionPolicy = z
  .object({
    /** JSON Schema URI for editor validation and autocomplete. */
    $schema: z.string().meta({
      description: "JSON Schema URI for editor validation and autocomplete.",
    }),

    /** Default permission mode when starting a session. */
    defaultMode: PermissionMode,

    /** Name of the active profile from `profiles`. */
    activeProfile: z.string().meta({
      description:
        "Name of the active profile from `profiles`. If unset, use the " +
        "top-level permission tiers directly.",
    }),

    /** Tool permission rules — evaluated in deny → ask → allow order. */
    permissions: PermissionTiers.meta({
      description:
        "Tool permission rules — evaluated in deny → ask → allow order.",
    }),

    /** Permission rules — unified deny-first evaluation. */
    rules: z.array(Rule).meta({
      description:
        "Permission rules. Evaluated deny-first: all deny rules checked, then ask, then allow. " +
        "Falls back to defaultMode when no rule matches.",
    }),

    /** Named permission profiles — selectable at session start. */
    profiles: Profiles.meta({
      description: "Named permission profiles.",
    }),

    /** Agent delegation controls — what subagents may do. */
    delegation: Delegation.meta({
      description: "Agent delegation controls — what subagents may do.",
    }),

    /** OS-level sandbox configuration. */
    sandbox: Sandbox.meta({
      description: "OS-level sandbox configuration.",
    }),

    /** Network access controls. */
    network: Network.meta({
      description: "Network access controls.",
    }),

    /** Environment variables injected into all agent sessions. */
    env: z.record(z.string(), z.string()).meta({
      description: "Environment variables injected into all agent sessions.",
      examples: [{ NODE_ENV: "development", DISABLE_TELEMETRY: "1" }],
    }),

    /**
     * Agent configs to include when loading. When set, only these agent
     * configs are read (plus canonical). Mutually exclusive with `without`.
     */
    with: z
      .array(
        z.enum(["claude-code", "codex", "kiro", "opencode", "crush", "omp"]),
      )
      .meta({
        description:
          "Agent configs to include when loading. Only these native configs " +
          "are read (plus canonical). Mutually exclusive with `without`.",
        examples: [["claude-code", "opencode"]],
      }),

    /**
     * Agent configs to exclude when loading. Mutually exclusive with `with`.
     */
    without: z
      .array(
        z.enum(["claude-code", "codex", "kiro", "opencode", "crush", "omp"]),
      )
      .meta({
        description:
          "Agent configs to exclude when loading. Mutually exclusive with `with`.",
        examples: [["codex"]],
      }),

    /**
     * How far to walk up the directory tree when loading configs.
     * `"all"` walks to the filesystem root. A number limits parent
     * directories (0 = cwd only). Controls both canonical and native
     * config discovery.
     */
    up: z.union([z.enum(["all"]), z.number().int().min(0)]).meta({
      description:
        "How far to walk up the directory tree when loading configs. " +
        "'all' walks to the filesystem root. A number limits parent directories (0 = cwd only).",
      default: "all",
      examples: ["all", 0, 3, 5],
    }),

    /** Sync configuration for the MCP server and CLI sync command. */
    sync: z
      .object({
        /**
         * Sync mode.
         * - `"sync"`: One-shot sync at startup, then exit.
         * - `"watch"`: Continuous sync via filesystem watching.
         * - `false`: No sync (MCP server is passive).
         */
        mode: z.union([z.enum(["sync", "watch"]), z.literal(false)]).meta({
          description:
            "Sync mode. 'sync' = one-shot at startup. 'watch' = continuous via fs.watch. false = disabled.",
          default: false,
        }),

        /** Write .bak files before overwriting. */
        backup: z.boolean().meta({
          description: "Write .bak files before overwriting.",
          default: false,
        }),
      })
      .partial()
      .meta({
        description:
          "Sync configuration for the MCP server and CLI sync command.",
      }),
  })
  .partial()
  .strict()
  .check((ctx) => {
    if (ctx.value.with !== undefined && ctx.value.without !== undefined) {
      ctx.issues.push({
        code: "custom",
        input: ctx.value,
        message: "'with' and 'without' are mutually exclusive.",
        path: ["with"],
      });
    }
  })
  .meta({
    title: "Agent Permission Policy",
    description:
      "Cross-agent permission policy for AI coding agents. Defines what tools agents may use, under what conditions, and how subagents are constrained. " +
      "The `with`/`without`/`up` fields control which native agent configs are " +
      "discovered and merged during walk-up loading. " +
      "Placed at .agents/permissions.json (team, committed) or .agents/permissions.local.json (personal, gitignored).",
  });

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type AgentPermissionPolicy = z.infer<typeof AgentPermissionPolicy>;
export type PermissionTiers = z.infer<typeof PermissionTiers>;
export type Rule = z.infer<typeof Rule>;
export type RuleCondition = z.infer<typeof RuleCondition>;
export type Delegation = z.infer<typeof Delegation>;
export type PermissionMode = z.infer<typeof PermissionMode>;
export type SandboxMode = z.infer<typeof SandboxMode>;
export type Sandbox = z.infer<typeof Sandbox>;
export type Profiles = z.infer<typeof Profiles>;
export type Network = z.infer<typeof Network>;
