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

`convert --output` creates files: it does not update existing ones. When the output is a policy or an agent's config file (a bare format name, or a path ending in the file's name, such as `.agents/permissions.json`, `.claude/settings.json`, `opencode.json` or `opencode.jsonc`, `.kiro/permissions.json`, `codex.toml` or `.crush.json`, or a local override), it is written only if it does not exist yet, wrapped as that agent reads it; if it exists, `convert` refuses, naming the file, and writes nothing, because merging a conversion into a file would replace settings the new policy lacks. Use `sync` to update existing files. An output path that is another agent's file than `--to` names (for example `--to opencode --output .claude/settings.json`) is refused, whether or not it exists. Oh My Pi's existing config is the one exception: its `bash.patterns` and `tools.approvalMode` are edited in place, as before. An output path that is no policy or agent config file receives the encoded document whole, replacing what is there, and a directory at the output path is refused as a directory.

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

`confine --output` follows the same rules as `convert --output`: it creates a policy or agent config file that does not exist yet, as that agent reads it, and refuses, naming the file, to overwrite an existing one (`sync` updates existing files). Any other output path receives the canonical policy whole.

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

A native JSON config is edited in place too, as text: sync replaces only the paths its codec models (`permissions.allow`, `permissions.deny`, `permissions.ask`, `permissions.defaultMode` and `permissions.additionalDirectories` in `.claude/settings.json`; the mapped tools beneath `permission` in OpenCode's config; `allowedTools` and the rule lists under `toolsSettings` in `.kiro/permissions.json`) and leaves every other byte of the file as it was, so other keys, unmodelled keys beneath `permissions`, comments, formatting, key order, number spelling and a byte order mark all survive. OpenCode's `list` and `websearch` are left as written: the codec folds them into the `Glob` and `WebFetch` rules, which it writes back as `glob` and `webfetch`, so replacing them would delete the original keys and a deny on them with it. A canonical file in the working directory that is malformed or fails the schema stops the sync like any other file sync would write, instead of being skipped and then replaced; a newer Claude Code `permissions.defaultMode` than the codec knows stops it the same way. A modelled path that appears more than once in the file, or whose parent does, is refused naming the file, the key and the line and column of each occurrence, whether or not its value would change, because the agent reads the last occurrence and a text edit cannot safely tell which one to change. A modelled path the merged policy has no value for is removed. Settings the codec does not model (Claude Code's `disableBypassPermissionsMode`, OpenCode's `doom_loop` and `skill`, Kiro's `autoAllowReadonly` flags, keys a newer agent version adds) are neither read nor rewritten.

Sync stops, naming the file, and writes nothing for any agent when a file it would write cannot be used: it exists but cannot be read (a permission error, a directory, an I/O error; only a missing file counts as new), it is not valid for the agent, its top level is not an object, a modelled path holds a value the codec cannot decode, or it changed after sync read it. Declining at the prompt, with an answer other than `y` or by the end of input (a closed pipe, CI), prints `Aborted.`, writes nothing and exits 1. If sync refuses a file it would write, the library call rejects with a `SyncRefusedError` carrying the file's `path` and a machine-readable `reason` (the CLI prints `fatal:` and exits 1). If writing stops part way, sync reports which files were written and which were not and exits 1; it does not roll back, and running it again converges. The canonical `.agents/permissions.json` is edited the same way: sync owns only the keys the merge produces (`defaultMode`, `rules`, `permissions.additionalDirectories`, `sandbox`, `network`, `profiles`, `activeProfile`, `delegation`, `roles` and `env`), and every other key, such as `sync`, `with`, `without`, `up`, `ceiling` and `$schema`, survives byte for byte. The merge folds `permissions.allow`, `deny` and `ask` into `rules`; those lists are left as written unless the merge changed the rules. A new canonical file is the merged policy with a schema reference. A config file that is empty, or only whitespace, holds no settings: as a source it contributes nothing and draws no warning, and as a target it is written as a new document, for every agent and for the canonical file. Files are read as bytes and must be valid UTF-8, and each is written through a temporary file in its directory (created with the final mode, never a wider one, and with the file's owner) and a rename, after checking again just before the rename that the file is unchanged. A symlink is followed and kept, and one that points at nothing is refused. `--backup` copies the original bytes to `<file>.bak` atomically, with the file's mode. Atomic replacement is not available for a file with more than one hard link or one that cannot be renamed over (a single-file bind mount): such a file is written in place, which keeps the link or mount and is not atomic. Claude Code's settings are strict JSON, so a comment or trailing comma in `.claude/settings.json` is refused with a message that says so; OpenCode accepts JSONC and loads both `opencode.json` and `opencode.jsonc`, applying `opencode.jsonc` after (above) `opencode.json`, so sync reads both, edits `opencode.jsonc` when it exists (comments outside the replaced values kept), never creates `opencode.json` beside it, accepts comments in `opencode.json`, and warns when both exist because OpenCode applies the one sync does not edit as well. A source that cannot be used (unreadable, not valid UTF-8, not valid for its agent, or holding a value the codec cannot decode) stops the sync only when sync would write that file, that is, a config file in the working directory or Oh My Pi's global config with `--omp-global`. Anywhere else, such as an ancestor directory's config or a local override, it is left out of the merge with a warning on stderr naming the file and the reason, since the agent applies that file itself and skipping it loosens nothing. The MCP daemon repeats such a warning only when the file's content changes.

Oh My Pi's config is YAML and is edited in place: only `bash.patterns` and `tools.approvalMode` change, and comments and every other key are kept. Sync reads the project's `.omp/config.yml` like any other native config, and also reads the global config (`config.yml`, or an existing `config.yaml`, in `$PI_CODING_AGENT_DIR`, else `~/.omp/agent`), because Oh My Pi replaces the global `bash.patterns` with a project's rather than joining them: a project list written without the global's entries would drop its denies. So the global's rules reach the merged policy, and `--without omp` keeps them out. The project file is written when it exists (or with `--create`); the global file is written only with `--omp-global`, since every Oh My Pi session on the machine reads it. Either file is always backed up to `.bak` before it is written, and one sync cannot read (invalid YAML, or an entry the codec refuses to decode) stops the sync instead of being overwritten. `tools.approvalMode` is only ever set to `always-ask`, Oh My Pi's strictest mode, and is left as it is when the policy leaves the mode to Oh My Pi. Oh My Pi reads a project config from the directory it runs in only, not from a parent. Named Oh My Pi profiles are not read.

## mcp

```bash
agent-perms mcp
```

Starts the MCP sync daemon on stdio. Sync config comes from `.agents/permissions.json` via the `sync` field. Typically invoked by agent harnesses via `npx agent-perms-mcp`, not run directly.

The daemon runs one sync at a time. Events that arrive while a sync is running, including those its own writes raise, collapse into a single follow-up run, so the daemon does not report its own writes as a failure.

| Flag                  | Description                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `--permission-prompt` | Expose the `permission_prompt` tool (see [Permission-prompt tool](mcp.md#permission-prompt-tool)) |
