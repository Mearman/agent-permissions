# Library API

Reference for using agent-perms as a library: the exports, the evaluator, the policy loader and watching policy files. The [README](../README.md) has the quick start.

# Exports

The package uses [wildcard exports](https://nodejs.org/api/packages.html#subpath-patterns): import only what you need.

## Programmatic API (`agent-perms/api`)

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

## Other modules

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

# Evaluator

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

## Converting string rules

```typescript
import { normaliseStringRule } from "agent-perms/evaluate";

// Convert Claude Code-style string rules to structured rules
const rule = normaliseStringRule("Bash(npm:*)", "allow");
// → { tool: "Bash", pattern: "npm:*", tier: "allow" }
```

# Policy loader

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

## Ceiling layers

A layer can bound the layers after it. Set `"ceiling": true` in a policy file (an organisation's, say) and the allow rules of layers loaded later, meaning deeper directories and local overrides, only take effect where that file also allows. They can still add `deny` and `ask` rules, and they can only make the default mode stricter.

```json
{
  "ceiling": true,
  "defaultMode": "restricted",
  "rules": [{ "tool": "Bash", "pattern": "git:*", "tier": "allow" }]
}
```

A project under that file can allow `git status`, which the ceiling already allows, but an allow for `npm run *` is ignored. A ceiling that allows nothing bounds nothing, and a ceiling never bounds layers before it. `mergeLayerPolicies` does the same for layers you supply yourself, each with a source name that `explain` reports.

## Watching for changes

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
