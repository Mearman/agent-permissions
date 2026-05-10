# Agent Permission Policy Spec

A vendor-neutral permission policy format for AI coding agents. One file works across Claude Code, OpenAI Codex, OpenCode, Crush, and any agent that adopts the spec.

## Quick start

Create `.agents/permissions.json` in your project root:

```json
{
  "$schema": "./agent-permissions.schema.json",
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
- **IDE support** — JSON Schema for autocomplete and validation via `"$schema"`

## File location

| File | Purpose | Git |
|---|---|---|
| `.agents/permissions.json` | Team-shared policy | Committed |
| `.agents/permissions.local.json` | Personal overrides | Gitignored |

Both files are merged at load time. Deny rules from any source short-circuit before allow rules.

## Schema overview

```typescript
interface AgentPermissionPolicy {
  // JSON Schema URI for editor validation
  $schema?: string;

  // Default mode: standard | autonomous | restricted | readonly
  // Also accepts Claude Code modes: plan | dontAsk | acceptEdits | bypassPermissions
  defaultMode?: PermissionMode;

  // Name of the active profile from `profiles`
  activeProfile?: string;

  // Tool permission rules — evaluated deny → ask → allow
  permissions?: {
    allow?: string[];   // Auto-approved tools
    deny?: string[];    // Always denied (short-circuits)
    ask?: string[];     // Always prompt (even in autonomous mode)
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

  // Named permission profiles — switch at session start
  profiles?: Record<string, PermissionTiers>;

  // Subagent controls
  delegation?: {
    maxDepth?: number;        // Default: 2
    nonDelegable?: string[];  // Tools subagents can't use
    bubbleUp?: boolean;       // Default: true
    agents?: Record<string, PermissionTiers>;  // Per-agent overrides
  };

  // OS-level sandboxing
  sandbox?: {
    mode?: "readonly" | "workspace-write" | "full-access";
    writableRoots?: string[];
    networkAccess?: boolean;
  };

  // Network access controls
  network?: {
    enabled?: boolean;
    domains?: Record<string, "allow" | "deny">;
  };

  // Environment variables for agent sessions
  env?: Record<string, string>;
}
```

All fields are optional. A valid policy can be as minimal as `{}`.

## Rule syntax

Rules use `Tool(pattern)` strings — compatible with Claude Code's permission format:

| Pattern | Matches |
|---|---|
| `Read` | All file reads |
| `Bash(git status)` | Exactly `git status` |
| `Bash(npm run test:*)` | Commands starting with `npm run test ` |
| `Bash(*rm* /)` | Commands containing `rm` and ending with ` /` |
| `Read(./.env)` | Reads at `./.env` |
| `Read(./secrets/**)` | Reads under `./secrets/` |
| `WebFetch(domain:example.com)` | Fetches to that domain |
| `mcp__github` | All tools from the `github` MCP server |
| `mcp__github__create_issue` | A specific MCP tool |

## Evaluation order

Rules are evaluated in **deny → ask → allow** order. Deny short-circuits — if any deny rule matches, the tool is blocked regardless of allow rules from any source.

```
deny rules (all sources merged) → ask rules → allow rules → defaultMode
```

## Agent compatibility

Bidirectional codecs convert between the canonical format and each agent's native config:

```typescript
import { claudeCodeCodec, codexCodec, opencodeCodec, crushCodec } from "agent-perms";
import { z } from "zod";

// Decode agent-native → canonical
const policy = claudeCodeCodec.decode(claudeSettings.permissions);

// Encode canonical → agent-native
const codexConfig = z.encode(codexCodec, policy);
```

| Agent | Native format | Codec | Fidelity |
|---|---|---|---|
| **Claude Code** | `Tool(pattern)` rule strings in `.claude/settings.json` | `claudeCodeCodec` | ✅ Lossless |
| **OpenCode** | Per-tool `ask/allow/deny` objects in `config.json` | `opencodeCodec` | Near-lossless¹ |
| **Codex** | Named profiles + sandbox in TOML config | `codexCodec` | Near-lossless² |
| **Crush** | Tool allowlist in `config.json` | `crushCodec` | Lossy³ |

¹ OpenCode's agent-specific tools (`doom_loop`, `lsp`, `skill`, `question`, `todowrite`) have no canonical equivalent. Per-agent markdown overrides must be handled by the caller.

² Codex's `on-failure` approval policy and granular approval config have no canonical equivalent. TOML serialisation is the caller's responsibility — the codec works on parsed JS objects.

³ Crush has no deny, no patterns, no modes — only a bare tool allowlist. Pattern rules and deny rules are lost on encode.

### Zero-translation migration from Claude Code

```bash
# Extract permissions from existing Claude Code settings — produces valid canonical input
jq '.permissions' .claude/settings.json > .agents/permissions.json
```

This works because the canonical spec accepts Claude Code's rule syntax, mode values, and `defaultMode` placement unchanged.

## Installation

```bash
pnpm add agent-perms
```

### Programmatic usage

```typescript
import {
  agentPermissionPolicy,
  claudeCodeCodec,
  codexCodec,
  z,
} from "agent-perms";

// Validate a policy file
const result = agentPermissionPolicy.safeParse(parsedJson);
if (!result.success) {
  console.error(result.error.issues);
}

// Convert between agent formats
const policy = claudeCodeCodec.decode(claudeSettings);
const codexConfig = z.encode(codexCodec, policy);
```

### JSON Schema for IDE support

```json
{
  "$schema": "./node_modules/agent-perms/agent-permissions.schema.json"
}
```

Or reference the schema in `.vscode/settings.json` for automatic association:

```json
{
  "json.schemas": [
    {
      "fileMatch": [".agents/permissions.json", ".agents/permissions.local.json"],
      "url": "./node_modules/agent-perms/agent-permissions.schema.json"
    }
  ]
}
```

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

### Full policy with profiles, sandbox, per-agent overrides

See [`spec/examples/full.json`](spec/examples/full.json).

## Development

```bash
pnpm install          # Install dependencies
pnpm test             # Run tests (142 tests)
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
