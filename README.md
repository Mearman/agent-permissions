# agent-perms

[![npm version](https://img.shields.io/npm/v/agent-perms.svg)](https://www.npmjs.com/package/agent-perms)
[![License](https://img.shields.io/badge/License-Apache--2.0-lightgrey.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Mearman/agent-permissions/ci.yml?branch=main)](https://github.com/Mearman/agent-permissions/actions)

A vendor-neutral permission policy format for AI coding agents. One file works across Claude Code, OpenAI Codex, OpenCode, Crush, and any agent that adopts the spec.

## Quick start

Create `.agents/permissions.json` in your project root:

```json
{
  "$schema": "https://raw.githubusercontent.com/Mearman/agent-permissions/main/agent-permissions.schema.json",
  "defaultMode": "standard",
  "rules": [
    { "tool": "Bash", "pattern": "sudo:*", "tier": "deny" },
    { "tool": "Read", "pattern": "./.env", "tier": "deny" },
    { "tool": "Bash", "pattern": "npm publish:*", "tier": "deny" },
    { "tool": "Bash", "pattern": "git status", "tier": "allow" },
    { "tool": "Bash", "pattern": "git:*", "tier": "allow" },
    { "tool": "Read", "tier": "allow" },
    { "tool": "Grep", "tier": "allow" },
    { "tool": "Bash", "pattern": "git push:*", "tier": "ask" },
    { "tool": "Bash", "pattern": "npm run *", "tier": "allow", "when": { "cwd": "./packages/*" } }
  ]
}
```

Every rule has a `tool`, an optional `pattern`, a `tier` (deny/ask/allow), and optional `when` conditions. Evaluation is deny-first: all deny rules are checked, then ask, then allow. Falls back to `defaultMode` when no rule matches.

**Zero-translation migration:** `jq '.permissions' .claude/settings.json > .agents/permissions.json` still works — the schema accepts Claude Code's `permissions.allow/deny/ask` arrays and the loader normalises them into rules.

## Why

Every coding agent has its own permission config. Teams using multiple agents (or migrating between them) maintain separate, often contradictory permission files. This spec provides:

- **One policy, many agents** — write once, convert to any agent's native format
- **Zero-translation migration** — Claude Code's `permissions` block is valid input
- **Superset coverage** — expresses features from all supported agents (sandboxing, named profiles, per-agent overrides, conditional rules)
- **IDE support** — JSON Schema for autocomplete and validation (submitted to [SchemaStore](https://github.com/SchemaStore/schemastore/pull/5666))

## File location

| File | Purpose | Git |
|---|---|---|
| `.agents/permissions.json` | Team-shared policy | Committed |
| `.agents/permissions.local.json` | Personal overrides | Gitignored |

Both files are merged at load time. Deny rules from any source short-circuit before allow rules.

## Installation

### As an MCP server

#### CLI shorthand

Some agent harnesses provide a one-command install:

**Claude Code (MCP):**

```bash
claude mcp add agent-perms -- npx -y agent-perms-mcp
```

**Claude Code (plugin marketplace):**

```
/plugin marketplace add https://github.com/Mearman/agent-permissions.git
/plugin install agent-perms@agent-perms
```

**OpenAI Codex:**

```bash
codex mcp add agent-perms -- npx -y agent-perms-mcp
```

#### Manual configuration

For harnesses that use config files, add the following to the `mcpServers` section:

```json
{
  "agent-perms": {
    "command": "npx",
    "args": ["-y", "agent-perms-mcp"]
  }
}
```

| Harness | Config file | Config key |
|---|---|---|
| Claude Code | `.mcp.json` (project) / `~/.claude.json` (user) | `mcpServers` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.agent-perms]` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` |
| Crush | `.crush.json` / `~/.config/crush/crush.json` | `mcp` |
| Cline | `.cline/mcp.json` | `mcpServers` |
| Cursor | `.cursor/mcp.json` | `mcpServers` |

The MCP server is a background sync daemon — it exposes no tools. It reads config from `.agents/permissions.json` and keeps native agent config files in sync.

### As a library

```bash
pnpm add agent-perms
```

## Exports

The package uses [wildcard exports](https://nodejs.org/api/packages.html#subpath-patterns) — import only what you need:

### Programmatic API (`agent-perms/api`)

Side-effect-free functions for use as a library:

```typescript
import { convert, validate, check, detectFormat } from "agent-perms/api";

// Convert between formats (auto-detects source)
const result = convert(undefined, "canonical", claudeCodeJson);
result.output;   // canonical object
result.from;     // "claude-code" (detected)
result.ruleCount; // 3

// Validate a policy
const { valid, errors } = validate(json);

// Evaluate a tool call
const { decision } = check("Bash", "sudo rm -rf /", policy, { branch: "main" });
// decision: "allow" | "deny" | "ask"

// Detect format from structure
const format = detectFormat(json); // "claude-code" | "crush" | "kiro" | ...
```

### Other modules

```typescript
// Zod schemas (single source of truth)
import { AgentPermissionPolicy } from "agent-perms/schema";

// Deny-first evaluator
import { evaluate } from "agent-perms/evaluate";

// Multi-layer policy loader
import { loadPolicy } from "agent-perms/loader";

// Bidirectional codecs for each agent
import { claudeCodeCodec } from "agent-perms/compat/codecs";

// SDK enum alignment checks
import { claudeCodeModes } from "agent-perms/compat/enums";

// Sync filesystem configs
import { sync } from "agent-perms/sync";
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

  // Permission rules — unified deny-first evaluation
  rules?: Array<{
    tool: string;         // e.g. "Bash", "Read", "mcp__github__*"
    pattern?: string;     // absent = match any input for this tool
    tier: "allow" | "deny" | "ask";
    when?: { cwd?: string; branch?: string };  // AND logic
  }>;

  // Claude Code compat — string rule arrays (normalised to rules on load)
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    additionalDirectories?: string[];
    defaultMode?: PermissionMode;
  };

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

Rules use `Tool(pattern)` strings inside `permissions` arrays — compatible with Claude Code's permission format. In the unified `rules` array, the tool and pattern are separate fields:

| Rule object | `permissions` string | Type | Matches |
|---|---|---|---|
| `{ tool: "Read" }` | `Read` | Bare | All invocations of `Read` |
| `{ tool: "Bash", pattern: "git status" }` | `Bash(git status)` | Exact | Exactly `git status` |
| `{ tool: "Bash", pattern: "npm:*" }` | `Bash(npm:*)` | Prefix | `npm` + space + anything |
| `{ tool: "Bash", pattern: "git commit *" }` | `Bash(git commit *)` | Wildcard | `git commit` + anything |
| `{ tool: "Bash", pattern: "domain:evil.com" }` | `Bash(domain:evil.com)` | Domain | Commands containing `evil.com` |
| `{ tool: "mcp__github" }` | `mcp__github` | MCP server | All tools from `github` MCP server |

### Evaluation order

```
deny rules → ask rules → allow rules → defaultMode
```

Deny short-circuits — if any deny rule matches, the tool is blocked regardless of allow rules from any source.

### Escape sequences

| Escape | Meaning |
|---|---|
| `\(` | Literal `(` in pattern |
| `\)` | Literal `)` in pattern |
| `\*` | Literal `*` (not a wildcard) |
| `\\` | Literal `\` |

## Evaluator

```typescript
import { evaluate, type PermissionPolicy, type EvaluationContext } from "agent-perms/evaluate";

const policy: PermissionPolicy = {
  defaultMode: "standard",
  rules: [
    { tool: "Bash", pattern: "sudo:*", tier: "deny" },
    { tool: "Bash", pattern: "git:*", tier: "allow" },
    { tool: "Read", tier: "allow" },
  ],
};

// Returns "deny" | "ask" | "allow"
evaluate(policy, "bash", "git status"); // "allow"
evaluate(policy, "bash", "sudo rm -rf /"); // "deny"
evaluate(policy, "bash", "npm install"); // "ask" (falls through to defaultMode)

// With context for conditional rules
const ctx: EvaluationContext = { cwd: "./packages/api", branch: "main" };
evaluate(policy, "bash", "npm run build", ctx);
```

Tool names are matched case-insensitively (`Bash` matches `bash`).

### Converting string rules

```typescript
import { normaliseStringRule } from "agent-perms/evaluate";

// Convert Claude Code-style string rules to structured rules
const rule = normaliseStringRule("Bash(npm:*)", "allow");
// → { tool: "Bash", pattern: "npm:*", tier: "allow" }
```

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

The loader normalises all `permissions` string arrays into structured `rules`. Deny rules from any layer short-circuit. Allow rules are additive.

## Agent compatibility

Bidirectional codecs convert between the canonical format and each agent's native config:

```typescript
import { claudeCodeCodec, codexCodec } from "agent-perms/compat/codecs";

// Decode agent-native → canonical
const policy = claudeCodeCodec.decode(claudeSettings.permissions);

// Encode canonical → agent-native
const codexConfig = codexCodec.encode(canonicalPolicy);
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

This works because the canonical spec accepts Claude Code's rule syntax, mode values, and `defaultMode` placement unchanged. The loader normalises `permissions` arrays into structured `rules`.

## CLI

The `agent-perms` binary converts, validates, and syncs permission configs.

**All flags, no positionals.** Format names resolve to default config file locations.
Use `-` for stdin/stdout.

```
claude-code  →  .claude/settings.json
canonical    →  .agents/permissions.json
opencode     →  opencode.json
kiro         →  .kiro/permissions.json
codex        →  codex.toml
crush        →  .crush.json
```

### convert

```bash
# Format name → reads/writes default config locations
agent-perms convert --from claude-code --to canonical

# File paths — auto-detects format from contents
agent-perms convert --from .claude/settings.json --to crush

# Piping with -
cat settings.json | agent-perms convert --from - --to canonical --output -

# Write to specific file
agent-perms convert --from claude-code --to canonical --output my-policy.json
```

| Flag | Short | Aliases | Description |
|------|-------|---------|-------------|
| `--from` | `-f` | `--input`, `--in` | Source (format, file, or `-` for stdin) |
| `--to` | `-t` | | Target format or file (required) |
| `--output` | `-o` | `--out` | Output file (overrides `--to` path), or `-` for stdout |
| `--compact` | `-c` | | Single-line JSON |
| `--verbose` | `-v` | | Show decode/encode summary on stderr |

### validate

```bash
agent-perms validate --input canonical
agent-perms validate --input .agents/permissions.json
echo '...' | agent-perms validate --input -
```

| Flag | Short | Aliases | Description |
|------|-------|---------|-------------|
| `--input` | `-i` | `--in` | Policy file (format, file, or `-` for stdin) |

Exits 0 if valid, 2 with error details if not.

### check

```bash
agent-perms check --tool Bash --input "git status" --policy-file canonical
agent-perms check --tool Bash --input "git status" --policy-file .agents/permissions.json
```

| Flag | Description |
|------|-------------|
| `--tool` | Tool name (required) |
| `--input` | Tool input string (required) |
| `--policy-file` | Policy file (format, file, or `-` for stdin) |
| `--cwd`, `--branch` | Evaluation context |

Exits 0 with `allow` or 1 with `deny`.

### sync

```bash
agent-perms sync
agent-perms sync --dry-run
agent-perms sync -w claude-code -w opencode
agent-perms sync -x codex
```

| Flag | Short | Description |
|------|-------|-------------|
| `--working-dir` | `-d` | Starting directory (default: cwd) |
| `--up <n\|all>` | `-u` | Ascend n parent directories (default: all) |
| `--with <agent>` | `-w` | Only sync these agents (repeatable) |
| `--without <agent>` | `-x` | Sync all except these agents (repeatable) |
| `--yes` | `-y` | Apply without prompting |
| `--dry-run` | | Show changes only, never write |
| `--create` | `-c` | Create config files that don't exist |
| `--verbose` | `-v` | Show rule provenance |
| `--backup` | `-b` | Write `.bak` files before overwriting |

Sync merges rules with deny-first semantics (deny > ask > allow for same tool+pattern).
Most restrictive `defaultMode` wins.

## JSON Schema for IDE support

Download the latest schema:

```
https://github.com/Mearman/agent-permissions/releases/latest/download/agent-permissions.schema.json
```

Reference from a policy file:

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
  "rules": [
    { "tool": "Bash", "pattern": "git status", "tier": "allow" },
    { "tool": "Bash", "pattern": "git diff:*", "tier": "allow" },
    { "tool": "Read", "tier": "allow" },
    { "tool": "Grep", "tier": "allow" },
    { "tool": "Read", "pattern": "./.env", "tier": "deny" },
    { "tool": "Bash", "pattern": "sudo:*", "tier": "deny" }
  ]
}
```

### Personal overrides (`.agents/permissions.local.json`)

```json
{
  "rules": [
    { "tool": "Bash", "pattern": "python3:*", "tier": "allow" },
    { "tool": "Bash", "pattern": "docker:*", "tier": "allow" }
  ]
}
```

### Rules — unconditional deny

Rules without `when` always apply, regardless of cwd or branch:

```json
{
  "rules": [
    { "tool": "Bash", "pattern": "npm publish:*", "tier": "deny" }
  ]
}
```

### Rules — conditional (cwd/branch)

Rules with `when` only match when all conditions are met (AND logic):

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
pnpm test             # Run tests (295 tests)
pnpm build            # Build ESM + CJS + types + JSON Schema
```

### Schema source of truth

The Zod schema in `src/schema.ts` is the single source of truth. The compiled JSON Schema (`agent-permissions.schema.json`) is generated via `z.toJSONSchema()` — never edit it by hand.

### Adding a new agent codec

1. Define the agent's native schema in `src/compat/codecs.ts`
2. Implement `z.codec(nativeSchema, AgentPermissionPolicy, { decode, encode })`
3. Add round-trip tests in `src/test/compat.test.ts`
4. Register in the `CODECS` export
