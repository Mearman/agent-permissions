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
export const permissionRule = z.string();

// ---------------------------------------------------------------------------
// Permission tier lists
// ---------------------------------------------------------------------------

export const permissionTiers = z
  .object({
    /**
     * Tools auto-approved without prompting.
     * Evaluated after deny rules — if a deny matches, allow is never checked.
     */
    allow: z
      .array(permissionRule)
      .meta({
        description:
          "Tools auto-approved without prompting. Evaluated after deny rules.",
        examples: [
          "Bash(git status)",
          "Bash(npm run test:*)",
          "Read",
          "Grep",
        ],
      }),

    /**
     * Tools always denied — short-circuits before allow and ask.
     * Deny rules from ALL sources are merged and checked first.
     * A deny cannot be overridden by an allow in any other source.
     */
    deny: z
      .array(permissionRule)
      .meta({
        description:
          "Tools always denied — short-circuits before allow and ask. A deny cannot be overridden by an allow in any other source.",
        examples: ["Bash(sudo:*)", "Bash(rm -rf /)", "Read(./.env)"],
      }),

    /**
     * Tools that always prompt, even in autonomous mode.
     * Evaluated after deny but before allow.
     */
    ask: z
      .array(permissionRule)
      .meta({
        description:
          "Tools that always prompt, even in autonomous mode. Evaluated after deny but before allow.",
        examples: ["Bash(git push:*)", "Bash(npm publish:*)"],
      }),

    /**
     * Directories beyond project root that agents may access.
     * Paths are relative to project root or absolute.
     */
    additionalDirectories: z
      .array(z.string())
      .meta({
        description:
          "Directories beyond project root that agents may access.",
        examples: ["../shared-libs/", "/tmp/build-cache"],
      }),
  })
  .partial()
  .strict();

// ---------------------------------------------------------------------------
// Conditional rules
// ---------------------------------------------------------------------------

export const ruleCondition = z
  .object({
    /** Working directory pattern (glob). */
    cwd: z
      .string()
      .meta({ description: "Working directory pattern (glob)." }),

    /** Git branch name pattern (glob). */
    branch: z
      .string()
      .meta({ description: "Git branch name pattern (glob)." }),
  })
  .partial();

export const conditionalRule = z
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

    /** Pattern to match against tool input. Same syntax as permission rules. */
    pattern: z.string().meta({
      description: "Pattern to match against tool input.",
      examples: ["npm run *", "./config/**", "git push --force:*"],
    }),

    /** Permission tier to apply when this rule matches. */
    tier: z.enum(["allow", "deny", "ask"]).meta({
      description: "Permission tier to apply when this rule matches.",
    }),

    /** Optional conditions. All must match for the rule to apply (AND logic). */
    when: ruleCondition.optional().meta({
      description:
        "Optional conditions. All must match for the rule to apply (AND logic).",
    }),
  })
  .meta({ description: "Conditional permission rule. First matching rule wins." });

// ---------------------------------------------------------------------------
// Delegation controls
// ---------------------------------------------------------------------------

export const delegation = z
  .object({
    /**
     * Maximum depth of agent nesting. 0 = no subagents allowed.
     * @default 2
     */
    maxDepth: z
      .number()
      .int()
      .min(0)
      .meta({
        description: "Maximum depth of agent nesting. 0 = no subagents allowed.",
        default: 2,
      }),

    /**
     * Tools that cannot be delegated to subagents.
     * Uses the same permission rule syntax.
     */
    nonDelegable: z.array(permissionRule).meta({
      description:
        "Tools that cannot be delegated to subagents. Uses the same rule syntax.",
      examples: ["Bash(sudo:*)", "Write(./.agents/**)"],
    }),

    /**
     * Whether subagents can request elevated permissions from their parent.
     * @default true
     */
    bubbleUp: z
      .boolean()
      .meta({
        description:
          "Whether subagents can request elevated permissions from their parent.",
        default: true,
      }),
  })
  .partial();

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
export const permissionMode = z
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
  ])
  .meta({
    description:
      "Default permission mode. Agent Permission Policy modes: standard, autonomous, restricted, readonly. " +
      "Claude Code compatible modes: plan, dontAsk, acceptEdits, bypassPermissions, default.",
    default: "standard",
  });

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

export const agentPermissionPolicy = z
  .object({
    /** JSON Schema URI for editor validation and autocomplete. */
    $schema: z.string().meta({
      description: "JSON Schema URI for editor validation and autocomplete.",
    }),

    /** Default permission mode when starting a session. */
    defaultMode: permissionMode,

    /** Tool permission rules — evaluated in deny → ask → allow order. */
    permissions: permissionTiers.meta({
      description:
        "Tool permission rules — evaluated in deny → ask → allow order.",
    }),

    /** Conditional rules — first matching rule wins. */
    rules: z
      .array(conditionalRule)
      .meta({
        description:
          "Conditional rules — pattern matching on tool input. First matching rule wins; falls back to permission tier arrays.",
      }),

    /** Agent delegation controls — what subagents may do. */
    delegation: delegation.meta({
      description: "Agent delegation controls — what subagents may do.",
    }),

    /** Environment variables injected into all agent sessions. */
    env: z
      .record(z.string(), z.string())
      .meta({
        description: "Environment variables injected into all agent sessions.",
        examples: [{ NODE_ENV: "development", DISABLE_TELEMETRY: "1" }],
      }),
  })
  .partial()
  .strict()
  .meta({
    title: "Agent Permission Policy",
    description:
      "Cross-agent permission policy for AI coding agents. Defines what tools agents may use, under what conditions, and how subagents are constrained. Placed at .agents/permissions.json (team, committed) or .agents/permissions.local.json (personal, gitignored).",
  });

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type AgentPermissionPolicy = z.infer<typeof agentPermissionPolicy>;
export type PermissionTiers = z.infer<typeof permissionTiers>;
export type ConditionalRule = z.infer<typeof conditionalRule>;
export type RuleCondition = z.infer<typeof ruleCondition>;
export type Delegation = z.infer<typeof delegation>;
export type PermissionMode = z.infer<typeof permissionMode>;
