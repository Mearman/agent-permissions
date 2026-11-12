# agent-perms

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/ExaDev/agent-permissions) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/agent-perms) [![Release](https://img.shields.io/github/v/release/ExaDev/agent-permissions)](https://github.com/ExaDev/agent-permissions/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/ExaDev/agent-permissions/ci.yml?branch=main)](https://github.com/ExaDev/agent-permissions/actions)

A vendor-neutral permission policy format for AI coding agents. One file works across Claude Code, OpenAI Codex, OpenCode, Crush, Oh My Pi, and any agent that adopts the spec.

[![npm downloads chart, log scale](https://shieldcn.dev/chart/npm/agent-perms.svg?bg=transparent&logo=false&yScale=log)](https://www.npmjs.com/package/agent-perms)

## Quick start

Create `.agents/permissions.json` in your project root:

```json
{
  "$schema": "https://github.com/ExaDev/agent-permissions/releases/latest/download/agent-permissions.schema.json",
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
    {
      "tool": "Bash",
      "pattern": "npm run *",
      "tier": "allow",
      "when": { "cwd": "./packages/*" }
    }
  ]
}
```

Every rule has a `tool`, an optional `pattern`, a `tier` (deny/ask/allow), and optional `when` conditions. Evaluation is deny-first: all deny rules are checked, then ask, then allow. Falls back to `defaultMode` when no rule matches.

**Zero-translation migration:** `jq '.permissions' .claude/settings.json > .agents/permissions.json` still works. The schema accepts Claude Code's `permissions.allow/deny/ask` arrays and the loader normalises them into rules.

## Why

Every coding agent has its own permission config. Teams using multiple agents (or migrating between them) maintain separate, often contradictory permission files. This spec provides:

- **One policy, many agents**: write once, convert to any agent's native format
- **Zero-translation migration**: Claude Code's `permissions` block is valid input
- **Superset coverage**: expresses features from all supported agents (sandboxing, named profiles, per-agent overrides, conditional rules)
- **IDE support**: JSON Schema for autocomplete and validation ([on SchemaStore](https://schemastore.org))

## File location

| File                             | Purpose            | Git        |
| -------------------------------- | ------------------ | ---------- |
| `.agents/permissions.json`       | Team-shared policy | Committed  |
| `.agents/permissions.local.json` | Personal overrides | Gitignored |

Both files are merged at load time. Deny rules from any source short-circuit before allow rules.

## Installation

### As an MCP server

#### CLI shorthand

Some agent harnesses provide a one-command install:

**Claude Code (MCP):**

```bash
claude mcp add agent-perms -- npx -y agent-perms mcp
```

**Claude Code (plugin marketplace):**

```
/plugin marketplace add https://github.com/ExaDev/agent-permissions.git
/plugin install agent-perms@agent-perms
```

**OpenAI Codex:**

```bash
codex mcp add agent-perms -- npx -y agent-perms mcp
```

#### Manual configuration

For harnesses that use config files, add the following to the `mcpServers` section:

```json
{
  "agent-perms": {
    "command": "npx",
    "args": ["-y", "agent-perms", "mcp"]
  }
}
```

| Harness     | Config file                                     | Config key                  |
| ----------- | ----------------------------------------------- | --------------------------- |
| Claude Code | `.mcp.json` (project) / `~/.claude.json` (user) | `mcpServers`                |
| Codex       | `~/.codex/config.toml`                          | `[mcp_servers.agent-perms]` |
| Gemini CLI  | `~/.gemini/settings.json`                       | `mcpServers`                |
| Crush       | `.crush.json` / `~/.config/crush/crush.json`    | `mcp`                       |
| Cline       | `.cline/mcp.json`                               | `mcpServers`                |
| Cursor      | `.cursor/mcp.json`                              | `mcpServers`                |

The MCP server is a background sync daemon. It reads config from `.agents/permissions.json` and keeps native agent config files in sync. By default it exposes no tools; with `--permission-prompt` it also exposes a tool that answers permission prompts from the policy (see [Permission-prompt tool](docs/mcp.md#permission-prompt-tool)).

### As a library

```bash
pnpm add agent-perms
```

## Schema overview

```typescript
import { type AgentPermissionPolicy } from "agent-perms/schema";

// All fields are optional. A valid policy can be as minimal as `{}`.
interface AgentPermissionPolicy {
  $schema?: string;

  // Default mode: standard | autonomous | restricted | readonly
  // Also accepts Claude Code modes: plan | dontAsk | acceptEdits | bypassPermissions
  defaultMode?: PermissionMode;

  activeProfile?: string;

  // Permission rules (deny-first evaluation)
  rules?: Array<{
    tool: string; // e.g. "Bash", "Read", "mcp__github__*"
    pattern?: string; // absent = match any input for this tool
    tier: "allow" | "deny" | "ask";
    when?: { cwd?: string; branch?: string }; // AND logic
  }>;

  // Claude Code compat: string rule arrays (normalised to rules on load)
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

## Agent compatibility

Bidirectional codecs convert between the canonical format and each agent's native config. Encoding never weakens a restrictive rule: an `allow` a target cannot express is left out, and a `deny` or `ask` it cannot express makes the conversion fail with an `UnsupportedCapabilityError` listing the rule. The footnotes on each codec, including what each refuses, are in [docs/agent-compatibility.md](docs/agent-compatibility.md).

| Agent           | Native format                                           | Codec             | Fidelity          |
| --------------- | ------------------------------------------------------- | ----------------- | ----------------- |
| **Claude Code** | `Tool(pattern)` rule strings in `.claude/settings.json` | `claudeCodeCodec` | Exact⁵            |
| **OpenCode**    | Per-tool `ask/allow/deny` objects in `config.json`      | `opencodeCodec`   | Exact or refused¹ |
| **Codex**       | Named profiles + sandbox in TOML config                 | `codexCodec`      | Exact or refused² |
| **Crush**       | Tool allowlist in `config.json`                         | `crushCodec`      | Allow only³       |
| **Oh My Pi**    | Ordered `bash.patterns` in `config.yml`                 | `ompCodec`        | Exact or refused⁴ |

The MCP sync daemon and the permission-prompt tool are in [docs/mcp.md](docs/mcp.md).

## JSON Schema for IDE support

The schema is included in [SchemaStore](https://schemastore.org). Editors that support it (VS Code, JetBrains, neovim) will automatically provide autocomplete and validation for `.agents/permissions.json` and `.agents/permissions.local.json` files with no configuration.

To explicitly reference the schema:

```json
{
  "$schema": "https://github.com/ExaDev/agent-permissions/releases/latest/download/agent-permissions.schema.json"
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

### Minimal: allow safe tools, deny secrets

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

### Full policy with profiles, sandbox, per-agent overrides

See [`spec/examples/full.json`](spec/examples/full.json).

## Development

```bash
pnpm install          # Install dependencies
pnpm test             # Run tests
pnpm build            # Build ESM + CJS + types + JSON Schema
```

### Schema source of truth

The Zod schema in `src/schema.ts` is the single source of truth. The compiled JSON Schema (`agent-permissions.schema.json`) is generated via `z.toJSONSchema()`. Never edit it by hand.

### Adding a new agent codec

1. Define the agent's native schema in `src/compat/codecs.ts`
2. Implement `z.codec(nativeSchema, AgentPermissionPolicy, { decode, encode })`
3. Add round-trip tests in `src/test/compat.test.ts`
4. Register in the `CODECS` export

## References

- [docs/rules.md](docs/rules.md): rule syntax, evaluation order, actors and roles, shell command lines, `when` conditions, profiles; read before writing or changing a rule.
- [docs/api.md](docs/api.md): library exports, evaluator, policy loader, watching policy files; read when embedding the package.
- [docs/agent-compatibility.md](docs/agent-compatibility.md): per-agent codec behaviour and refusals; read before changing or relying on a codec.
- [docs/mcp.md](docs/mcp.md): the sync daemon and the permission-prompt tool.
- [docs/cli.md](docs/cli.md): every command and flag.
- [CONTRIBUTING.md](CONTRIBUTING.md): the commit and release loop.
