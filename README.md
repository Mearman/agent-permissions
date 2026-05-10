# agent-perms

[![npm version](https://img.shields.io/npm/v/agent-perms.svg)](https://www.npmjs.com/package/agent-perms)
[![License](https://img.shields.io/badge/License-Apache--2.0-lightgrey.svg)](https://opensource.org/licenses/Apache-2.0)
[![CI](https://img.shields.io/github/actions/workflow/status/Mearman/agent-permissions/ci.yml?branch=main)](https://github.com/Mearman/agent-permissions/actions)

A vendor-neutral permission policy format for AI coding agents. One file works across Claude Code, OpenAI Codex, OpenCode, Crush, and any agent that adopts the spec.

## Quick start

Create `.agents/permissions.json` in your project root:

```json
{
  "$schema": "https://raw.githubusercontent.com/Mearman/agent-permissions/main/agent-permissions.schema.json",
  "permissions": {
    "allow": ["Bash(git status)", "Bash(npm run test:*)", "Read", "Grep"],
    "deny": ["Bash(sudo:*)", "Read(./.env)"],
    "ask": ["Bash(git push:*)", "Bash(npm publish:*)"]
  }
}
```

That's it. The same file can be converted to any supported agent's native format using the built-in codecs.

## Why

Every coding agent has its own permission config. Teams using multiple agents (or migrating between them) maintain separate, often contradictory permission files. This spec provides:

- **One policy, many agents** — write once, convert to any agent's native format
- **Zero-translation migration** — `jq '.permissions' .claude/settings.json > .agents/permissions.json` produces valid input
- **Superset coverage** — expresses features from all supported agents (sandboxing, named profiles, per-agent overrides, conditional rules)
- **IDE support** — JSON Schema for autocomplete and validation (submitted to [SchemaStore](https://github.com/SchemaStore/schemastore/pull/5666))

## File location

| File | Purpose | Git |
|---|---|---|
| `.agents/permissions.json` | Team-shared policy | Committed |
| `.agents/permissions.local.json` | Personal overrides | Gitignored |

Both files are merged at load time. Deny rules from any source short-circuit before allow rules.

## Installation

```bash
pnpm add agent-perms
```

## Exports

The package uses [wildcard exports](https://nodejs.org/api/packages.html#subpath-patterns) — import only what you need:

```typescript
// Zod schemas (single source of truth)
import { agentPermissionPolicy } from "agent-perms/schema";

// Deny-first evaluator
import { evaluate } from "agent-perms/evaluate";

// Multi-layer policy loader
import { loadPolicy } from "agent-perms/loader";

// Bidirectional codecs for each agent
import { claudeCodeCodec } from "agent-perms/compat/codecs";

// SDK enum alignment checks
import { claudeCodeModes } from "agent-perms/compat/enums";
```

## Schema overview

```typescript
import { type AgentPermissionPolicy } from "agent-perms/schema";

// All fields are optional — a valid policy can be as minimal as `{}`.
interface AgentPermissionPolicy {
  $schema?: string;

  // Default mode: standard | autonomous | restricted | readonly
  // Also accepts Claude Code modes: plan | dontAsk | acceptEdits | bypassPermissions
  defaultMode?: PermissionMode;

  activeProfile?: string;

  // Tool permission rules — evaluated deny → ask → allow
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    additionalDirectories?: string[];
    defaultMode?: PermissionMode;
  };

  // Conditional rules with cwd/branch conditions
  rules?: Array<{
    tool: string;
    pattern: string;
    tier: "allow" | "deny" | "ask";
    when?: { cwd?: string; branch?: string };
  }>;

  profiles?: Record<string, PermissionTiers>;

  delegation?: {
    maxDepth?: number;
    nonDelegable?: string[];
    bubbleUp?: boolean;
    agents?: Record<string, PermissionTiers>;
  };

  sandbox?: {
    mode?: "readonly" | "workspace-write" | "full-access";
    writableRoots?: string[];
    networkAccess?: boolean;
  };

  network?: {
    enabled?: boolean;
    domains?: Record<string, "allow" | "deny">;
  };

  env?: Record<string, string>;
}
```

## Rule syntax

Rules use `Tool(pattern)` strings — compatible with Claude Code's permission format:

| Pattern | Type | Matches |
|---|---|---|
| `Read` | Bare | All invocations of the `Read` tool |
| `Bash(git status)` | Exact | Exactly `git status` |
| `Bash(npm:*)` | Prefix | `npm` + space + anything, or bare `npm` |
| `Bash(git commit *)` | Wildcard | `git commit` + anything (including bare `git commit`) |
| `Bash(* Dockerfile)` | Wildcard | Any command ending with ` Dockerfile` |
| `Bash(domain:evil.com)` | Domain | Commands containing `evil.com` |
| `mcp__github` | MCP server | All tools from the `github` MCP server |
| `mcp__*__delete*` | MCP wildcard | Any server's tools starting with `delete` |

### Escape sequences

| Escape | Meaning |
|---|---|
| `\(` | Literal `(` in pattern content |
| `\)` | Literal `)` in pattern content |
| `\*` | Literal `*` (not a wildcard) |
| `\\` | Literal `\` |

### Evaluation order

Rules are evaluated in **deny → ask → allow** order. Deny short-circuits — if any deny rule matches, the tool is blocked regardless of allow rules from any source.

```
conditional rules (rules[]) → deny → ask → allow → defaultMode
```

Conditional rules are checked first. The first matching conditional rule wins. If none match, the tier arrays are checked in deny → ask → allow order.

## Evaluator

```typescript
import { evaluate, type PermissionPolicy, type EvaluationContext } from "agent-perms/evaluate";

const policy: PermissionPolicy = {
  defaultMode: "standard",
  permissions: {
    deny: ["Bash(sudo:*)"],
    allow: ["Bash(git:*)", "Read"],
  },
};

// Basic evaluation — returns "deny" | "ask" | "allow"
evaluate(policy, "bash", "git status"); // "allow"
evaluate(policy, "bash", "sudo rm -rf /"); // "deny"
evaluate(policy, "bash", "npm install"); // "ask" (falls through to defaultMode)

// With context for conditional rules
const ctx: EvaluationContext = { cwd: "./packages/api", branch: "main" };
evaluate(policy, "bash", "npm run build", ctx);
```

Tool names are matched case-insensitively (`Bash` matches `bash`).

## Policy loader

```typescript
import { loadPolicy } from "agent-perms/loader";

const policy = await loadPolicy({
  cwd: process.cwd(),
  nativeSources: ["claude-code"], // also load .claude/settings.json
});
```

Loads and merges layers in order:

1. `.agents/permissions.json` (team-shared)
2. `.agents/permissions.local.json` (personal overrides)
3. Native agent configs (`.claude/settings.json`, etc.) — if `nativeSources` is set

Deny rules from any layer short-circuit. Allow rules are additive.

## Agent compatibility

Bidirectional codecs convert between the canonical format and each agent's native config:

```typescript
import { claudeCodeCodec, codexCodec } from "agent-perms/compat/codecs";

// Decode agent-native → canonical
const policy = claudeCodeCodec.parse(claudeSettings.permissions);

// Encode canonical → agent-native
const codexConfig = codexCodec.parse(canonicalPolicy);
```

| Agent | Native format | Codec | Fidelity |
|---|---|---|---|
| **Claude Code** | `Tool(pattern)` rule strings in `.claude/settings.json` | `claudeCodeCodec` | Lossless |
| **OpenCode** | Per-tool `ask/allow/deny` objects in `config.json` | `opencodeCodec` | Near-lossless¹ |
| **Codex** | Named profiles + sandbox in TOML config | `codexCodec` | Near-lossless² |
| **Crush** | Tool allowlist in `config.json` | `crushCodec` | Lossy³ |

¹ OpenCode's agent-specific tools have no canonical equivalent. Per-agent markdown overrides must be handled by the caller.

² Codex's `on-failure` approval policy and granular approval config have no canonical equivalent. TOML serialisation is the caller's responsibility — the codec works on parsed JS objects.

³ Crush has no deny, no patterns, no modes — only a bare tool allowlist. Pattern rules and deny rules are lost on encode.

### Zero-translation migration from Claude Code

```bash
jq '.permissions' .claude/settings.json > .agents/permissions.json
```

This works because the canonical spec accepts Claude Code's rule syntax, mode values, and `defaultMode` placement unchanged.

## JSON Schema for IDE support

```json
{
  "$schema": "https://raw.githubusercontent.com/Mearman/agent-permissions/main/agent-permissions.schema.json"
}
```

Or reference locally:

```json
{
  "$schema": "./node_modules/agent-perms/agent-permissions.schema.json"
}
```

The schema file ships with the package at `agent-perms/agent-permissions.schema.json`.

## Examples

### Minimal — allow safe tools, deny secrets

```json
{
  "permissions": {
    "allow": ["Bash(git status)", "Bash(git diff:*)", "Read", "Grep"],
    "deny": ["Read(./.env)", "Bash(sudo:*)"]
  }
}
```

### Personal overrides (`.agents/permissions.local.json`)

```json
{
  "permissions": {
    "allow": ["Bash(python3:*)", "Bash(docker:*)"]
  }
}
```

### Conditional rules — restrict publishing on main

```json
{
  "rules": [
    {
      "tool": "Bash",
      "pattern": "npm publish:*",
      "tier": "deny",
      "when": { "branch": "main", "cwd": "./packages/core" }
    }
  ]
}
```

### Full policy with profiles, sandbox, per-agent overrides

See [`spec/examples/full.json`](spec/examples/full.json).

## Development

```bash
pnpm install          # Install dependencies
pnpm test             # Run tests (212 tests)
pnpm build            # Build ESM + CJS + types + JSON Schema
```

### Schema source of truth

The Zod schema in `src/schema.ts` is the single source of truth. The compiled JSON Schema (`agent-permissions.schema.json`) is generated via `z.toJSONSchema()` — never edit it by hand.

### Adding a new agent codec

1. Define the agent's native schema in `src/compat/codecs.ts`
2. Implement `z.codec(nativeSchema, agentPermissionPolicy, { decode, encode })`
3. Add round-trip tests in `src/test/compat.test.ts`
4. Register in the `CODECS` export

## License

Apache-2.0
