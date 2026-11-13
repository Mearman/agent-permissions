# CLI

The `agent-perms` binary: every command, its flags and its behaviour.

# CLI

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

## convert

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

When the output is an agent's own config file (a bare format name, or a path ending in that agent's file name such as `.claude/settings.json`), the encoded permissions are merged into the file by the writer `sync` uses, so its other settings survive, and a file that cannot be read as that agent's format is refused. An output path that is not an agent's config file receives the encoded document whole.

## validate

```bash
agent-perms validate --input canonical
agent-perms validate --input .agents/permissions.json
echo '...' | agent-perms validate --input -
```

| Flag      | Short | Aliases | Description                                  |
| --------- | ----- | ------- | -------------------------------------------- |
| `--input` | `-i`  | `--in`  | Policy file (format, file, or `-` for stdin) |

Exits 0 if valid, 2 with error details if not.

## check

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

## replay

```bash
agent-perms replay --transcript session.jsonl --policy-file canonical
```

| Flag            | Description                                  |
| --------------- | -------------------------------------------- |
| `--transcript`  | Session transcript (file, or `-` for stdin)  |
| `--policy-file` | Policy file (format, file, or `-` for stdin) |

Judges every tool call in the transcript against the policy and prints how many it would allow, ask about and deny, one `decision<TAB>count` line each. It then lists the calls whose recorded outcome the policy could not have produced, as `decision<TAB>outcome<TAB>tool<TAB>input`. A call that ran is consistent with `allow` or `ask`, a call a rule denied with `deny`, and a call the user declined with `ask`; a call with no recorded result is counted but never listed. Each call is judged in the working directory and branch recorded with it, so `when` conditions apply as they did at the time.

## suggest

```bash
agent-perms suggest --transcript session.jsonl --policy-file canonical > proposed.json
```

| Flag              | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `--transcript`    | Session transcript (file, or `-` for stdin)                      |
| `--policy-file`   | Policy whose deny rules exclude calls and allow rules cover them |
| `--min-count <n>` | Approved calls a rule must cover (default: 2)                    |

Prints a canonical policy of proposed `allow` rules on stdout, and each rule with how many approved calls it covers on stderr. Only calls that ran count as approved, and a `Bash` line counts command by command. A command is never proposed when it appeared in a line a policy rule denies or that the transcript records as denied or declined, and commands the policy already allows, or a rule asks about, are left out. Commands sharing a first word become one prefix rule on the words they all start with (`npm run build` and `npm run lint` give `npm run:*`), unless that prefix would also match an excluded command, in which case each repeated command gets an exact rule. Other tools get an exact rule on their path or URL, or a bare rule when the tool has no such input. Review the proposal before adopting it: a prefix rule allows arguments that were never observed.

## Transcript format

Both commands read Claude Code session logs (the `.jsonl` files under `~/.claude/projects/`). The parser reads `tool_use` blocks (`id`, `name`, `input`) and `tool_result` blocks (`tool_use_id`, `is_error`, `content`) from each entry's `message.content`, plus the entry's `cwd` and `gitBranch` as the call's context. The log records no environment variables or git remote, so a `when` condition on either is unknown during a replay: it can still deny or ask, but never allows. The input rules match against is `command` for `Bash`, `file_path` for `Read`, `Write`, `Edit` and `MultiEdit`, `notebook_path` for `NotebookEdit` and `url` for `WebFetch`. A log does not say which rule decided a call, or whether a call that ran was allowed outright or approved when asked; it records only the outcome, which is read from the result text: an error starting `Permission to use` and containing `has been denied` is a denial, an error starting `The user doesn't want to proceed with this tool use.` is a declined request, and anything else means the call ran.

## confine

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

With `--output` set to a bare format name other than `canonical`, or to a path ending in an agent's config file name, the policy is encoded for that agent and merged into the file in the same way as `convert`; any other output path receives the canonical policy whole.

Prints a canonical policy that allows `Read`, `Edit` and `Write` on each root and everything below it, and lists the roots other than the working directory under `permissions.additionalDirectories`. Relative roots resolve against the working directory; paths are made absolute, `.` and `..` segments are collapsed, trailing separators are dropped and duplicates are removed.

**What it can and cannot express.** Evaluation is deny-first and patterns are exact, `prefix:*` or `*` wildcards, none of which can negate. "Deny everything outside the roots" therefore cannot be written: a blanket deny would also beat the allow rules for the roots. Instead the policy:

- allows the file tools on `<root>` and `<root>/*`, so a sibling sharing the root as a string prefix (`/work/app-secrets` for `/work/app`) is not matched;
- denies any path containing a `..` segment, because the wildcard `/work/app/*` would otherwise match the text `/work/app/../secret`;
- sets `defaultMode` to `restricted` (outside paths ask) or, with `--outside deny`, `readonly` (outside paths are refused). That mode is global: it also applies to every other tool that has no rule of its own, so `readonly` refuses `Bash` calls that no rule allows.

Tool inputs are matched as literal text. A path given relative to the working directory matches no root rule and falls to the default mode.

**This is not a sandbox.** Only the file tools are constrained. A `Bash` command can still read or write anywhere, and other tools are untouched. To restrict what shell commands can reach, use the policy's `sandbox` field.

## sync

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
| `--omp-global`      |       | Also write Oh My Pi's global config        |

Sync merges rules with deny-first semantics (deny > ask > allow for same tool+pattern).
Most restrictive `defaultMode` wins.

If an agent's codec refuses a rule in the merged policy (see the compatibility table), sync reports the refused rules, writes nothing for any agent, and exits 1. Leave that agent out with `--without` to sync the others.

A native JSON config is edited in place too, as text: sync replaces only the paths its codec models (`permissions.allow`, `permissions.deny`, `permissions.ask`, `permissions.defaultMode` and `permissions.additionalDirectories` in `.claude/settings.json`; the mapped tools beneath `permission` in OpenCode's config; `allowedTools` and the rule lists under `toolsSettings` in `.kiro/permissions.json`) and leaves every other byte of the file as it was, so other keys, unmodelled keys beneath `permissions`, comments, formatting, key order, number spelling and a byte order mark all survive. A modelled path the merged policy has no value for is removed. Settings the codec does not model (Claude Code's `disableBypassPermissionsMode`, OpenCode's `doom_loop` and `skill`, Kiro's `autoAllowReadonly` flags, keys a newer agent version adds) are neither read nor rewritten.

Sync stops, naming the file, and writes nothing for any agent when a file it would write cannot be used: it exists but cannot be read (a permission error, a directory, an I/O error; only a missing file counts as new), it is not valid for the agent, its top level is not an object, a modelled path holds a value the codec cannot decode, or it changed after sync read it. Each file is written through a temporary file in its directory and a rename, a symlink is followed and kept, and an existing file keeps its mode. Claude Code's settings are strict JSON, so a comment or trailing comma in `.claude/settings.json` is refused with a message that says so; OpenCode accepts JSONC, so sync reads and edits `opencode.jsonc` when it exists (comments kept), never creates `opencode.json` beside it, and accepts comments in `opencode.json`. A source that is not valid for its agent and that sync would not write is skipped with a warning.

Oh My Pi's config is YAML and is edited in place: only `bash.patterns` and `tools.approvalMode` change, and comments and every other key are kept. Sync reads the project's `.omp/config.yml` like any other native config, and also reads the global config (`config.yml`, or an existing `config.yaml`, in `$PI_CODING_AGENT_DIR`, else `~/.omp/agent`), because Oh My Pi replaces the global `bash.patterns` with a project's rather than joining them: a project list written without the global's entries would drop its denies. So the global's rules reach the merged policy, and `--without omp` keeps them out. The project file is written when it exists (or with `--create`); the global file is written only with `--omp-global`, since every Oh My Pi session on the machine reads it. Either file is always backed up to `.bak` before it is written, and one sync cannot read (invalid YAML, or an entry the codec refuses to decode) stops the sync instead of being overwritten. `tools.approvalMode` is only ever set to `always-ask`, Oh My Pi's strictest mode, and is left as it is when the policy leaves the mode to Oh My Pi. Oh My Pi reads a project config from the directory it runs in only, not from a parent. Named Oh My Pi profiles are not read.

## mcp

```bash
agent-perms mcp
```

Starts the MCP sync daemon on stdio. Sync config comes from `.agents/permissions.json` via the `sync` field. Typically invoked by agent harnesses via `npx agent-perms-mcp`, not run directly.

| Flag                  | Description                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `--permission-prompt` | Expose the `permission_prompt` tool (see [Permission-prompt tool](mcp.md#permission-prompt-tool)) |
