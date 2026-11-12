# Agent compatibility

How each supported agent's native format converts to and from the canonical policy, and what each codec refuses.

# Agent compatibility

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

⁴ Oh My Pi enforces `bash.patterns`: an ordered list of `match` globs (only `*` is special, whitespace is collapsed, the first matching entry wins) with approval `allow`, `prompt` or `deny`. Its `deny` and `prompt` entries also catch a matching command inside a compound line, and an `allow` entry never approves a compound line, which agrees with how a canonical policy judges a shell line. Encoding writes deny entries first, then prompt, then allow, because OMP takes the first match and a canonical policy takes the strictest. A canonical prefix rule (`git push:*`) and a trailing wildcard (`git *`) are each written twice, as the bare command and the command with arguments, since OMP's `git *` does not match `git`. `ask` becomes `prompt`. A `deny` or `ask` for any tool but Bash, one that carries a condition, one on a literal asterisk (OMP cannot write one), an actor or role limit, or an ask that names approvers makes the encode fail with an `UnsupportedCapabilityError`; an `allow` OMP cannot express is left out, which is stricter. The default mode becomes OMP's `tools.approvalMode`, which decides calls no entry covers by the tier each tool declares: `always-ask` approves reads and prompts for writes and commands, `write` prompts for commands only, and `yolo`, OMP's own default, approves everything. `standard` and `restricted` (and the modes the evaluator reads as them) are written as `always-ask`; `autonomous` writes nothing, leaving OMP's own mode in place; `readonly` is refused, since OMP has no mode that denies what no entry covers. The one gap: no OMP mode prompts for a read, so a read that `standard` or `restricted` would ask about is approved. OMP's other settings are not converted. Decoding reads `always-ask` and `write` as `standard` and `yolo` as `autonomous`, and reads the entries in order, failing on anything it cannot read faithfully (an unknown mode, a bad approval, an empty match, a match ending in `:*`) rather than skipping it. `agent-perms convert` reads and writes OMP's config as YAML, editing an existing file in place so only `bash.patterns` and `tools.approvalMode` change; `agent-perms sync` keeps a project's `.omp/config.yml`, and with `--omp-global` the global one, in step (see [sync](cli.md#sync)).

⁵ Claude Code holds a rule as a `Tool(pattern)` string and nothing else, so a condition (`when`) is not written. An `allow` limited by a condition is left out, since it would otherwise apply everywhere; a `deny` or `ask` is written without it and applies everywhere, which is stricter. A canonical default mode Claude Code has no name for is written as the closest one that is not looser: `readonly` as `dontAsk`, `restricted` and `standard` as `default`. Claude Code's own `dontAsk` refuses every call no rule allows, and is read that way.

## Zero-translation migration from Claude Code

```bash
jq '.permissions' .claude/settings.json > .agents/permissions.json
```

This works because the canonical spec accepts Claude Code's rule syntax, mode values, and `defaultMode` placement unchanged. The loader normalises `permissions` arrays into structured `rules`.
