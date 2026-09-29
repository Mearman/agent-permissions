#!/usr/bin/env node
/**
 * Agent-perms CLI: convert, validate, check, and sync cross-agent permission policies, and replay
 * them over recorded sessions.
 *
 * All flags, no positionals. Format names resolve to default config file locations. Use "-" for
 * stdin/stdout.
 *
 * Exit codes: 0 = success, 1 = error, 2 = validation failure.
 */

import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import {
  convert,
  validate as validateApi,
  check as checkApi,
  replay as replayApi,
  suggest as suggestApi,
  resolveFormat,
  ConvertError,
  type CheckContext,
  type Format,
} from "./api.ts";
import { agentId } from "./compat/codecs.ts";
import { ruleToString, stepSource, type DecisionStep } from "./evaluate.ts";
import { confine, type OutsideBehaviour } from "./confine.ts";
import { sync } from "./sync.ts";
import {
  AGENT_FILES,
  findDefaultFile,
  readInput,
  parseAgentFile,
  parseJson,
  stringifyAgentFile,
  writeJsonFile,
} from "./agent-files.ts";

const AGENTS = agentId.options;
type Agent = (typeof AGENTS)[number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function error(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function isAgent(value: string): value is Agent {
  for (const agent of AGENTS) {
    if (agent === value) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/** Resolve a spec to an input file path. Format name → walk up, file path → direct, "-" → stdin. */
function resolveInputSpec(spec: string | undefined): string | undefined {
  if (spec === undefined || spec === "-") return undefined;
  const format = resolveFormat(spec);
  if (format) return findDefaultFile(format, process.cwd());
  return resolve(spec);
}

/** Resolve a spec to an output file path. Format name → cwd, file path → direct, "-" → stdout. */
function resolveOutputSpec(spec: string | undefined): string | undefined {
  if (spec === undefined || spec === "-") return undefined;
  const format = resolveFormat(spec);
  if (format) {
    const fileName = AGENT_FILES[format].name;
    return resolve(join(process.cwd(), fileName));
  }
  return resolve(spec);
}
function firstString(
  ...values: (string | boolean | undefined)[]
): string | undefined {
  for (const v of values) {
    if (typeof v === "string") return v;
  }
  return undefined;
}

function allStrings(
  ...values: ((string | boolean | undefined)[] | undefined)[]
): string[] {
  const result: string[] = [];
  for (const arr of values) {
    if (arr === undefined) continue;
    for (const v of arr) {
      if (typeof v === "string") result.push(v);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

async function convertCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      from: { type: "string", short: "f" },
      to: { type: "string", short: "t" },
      input: { type: "string" },
      in: { type: "string" },
      output: { type: "string", short: "o" },
      out: { type: "string" },
      compact: { type: "boolean", short: "c" },
      verbose: { type: "boolean", short: "v" },
    },
    strict: true,
  });

  // Merge aliases: --input/--in → --from
  const fromSpec = firstString(values.from, values.input, values.in);
  // --to is always the target format/file
  const toSpec = values.to;
  // --output/--out overrides destination (--to might set it too)
  const outputSpec = firstString(values.output, values.out);
  if (toSpec === undefined) error("--to is required");

  // Resolve input: format name finds file, file path reads directly, omitted = stdin
  const inputPath = resolveInputSpec(fromSpec);
  let fromFormat: Format | undefined;
  if (fromSpec !== undefined && fromSpec !== "-") {
    fromFormat = resolveFormat(fromSpec);
    // If not a known format name and not an existing file, it's an unknown format
    if (
      fromFormat === undefined &&
      inputPath !== undefined &&
      !existsSync(inputPath)
    ) {
      error(
        `unknown --from format: ${fromSpec}. Use an agent name, a config file path, or "-" for stdin`,
      );
    }
  }

  // Resolve output: format name → default file, file path → directly, "-" = stdout
  const toFormat = resolveFormat(toSpec);
  if (!toFormat) {
    error(
      `unknown --to format: ${toSpec}. Use an agent name (claude-code, codex, kiro, opencode, crush, omp, canonical), a config file path, or "-" for stdout`,
    );
  }
  const outputPath = outputSpec
    ? resolveOutputSpec(outputSpec)
    : resolveOutputSpec(toSpec);

  // No need to validate --from — auto-detect handles unknown file paths

  const source = inputPath ?? "stdin";
  const raw = await readInput(inputPath);
  const parsed = parseAgentFile(fromFormat, raw, source);
  if (!parsed.ok) error(parsed.error);
  const json = parsed.value;

  try {
    const result = convert(fromFormat, toFormat, json);

    const jsonStr = stringifyAgentFile(
      toFormat,
      result.output,
      values.compact === true,
    );

    if (outputPath) {
      await writeJsonFile(outputPath, jsonStr);
    } else {
      process.stdout.write(jsonStr);
    }

    if (values.verbose) {
      const dest = outputPath ?? "stdout";
      process.stderr.write(
        `Decoded ${result.from} → canonical (${String(result.ruleCount)} rules), encoded → ${toFormat}, wrote ${dest}\n`,
      );
    }
  } catch (e) {
    if (e instanceof ConvertError) {
      process.stderr.write(`error: ${e.message}\n`);
      for (const err of e.errors) {
        process.stderr.write(`  ${err.path}: ${err.message}\n`);
      }
      process.exit(2);
    }
    const message = e instanceof Error ? e.message : String(e);
    error(message);
  }
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

async function validateCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", short: "i" },
      in: { type: "string" },
    },
    strict: true,
  });

  const inputSpec = firstString(values.input, values.in);
  const inputPath = resolveInputSpec(inputSpec);
  const source = inputPath ?? "stdin";

  const raw = await readInput(inputPath);
  const parsed = parseJson(raw, source);
  if (!parsed.ok) error(parsed.error);
  const json = parsed.value;

  const result = validateApi(json);
  if (result.valid) {
    process.stdout.write("valid\n");
    return;
  }

  process.stderr.write("validation errors:\n");
  for (const err of result.errors) {
    process.stderr.write(`  ${err.path}: ${err.message}\n`);
  }
  process.exit(2);
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/** Read repeated `--env NAME=VALUE` flags into the record the evaluation context takes. */
function parseEnvFlags(flags: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const flag of flags) {
    const equals = flag.indexOf("=");
    if (equals <= 0) error(`--env expects NAME=VALUE, got "${flag}"`);
    env[flag.slice(0, equals)] = flag.slice(equals + 1);
  }
  return env;
}

/** Read `--depth`, the number of agents between the call and the top-level agent. */
function parseDepthFlag(flag: string): number {
  const depth = Number(flag);
  if (!Number.isInteger(depth) || depth < 0) {
    error(`--depth expects a whole number of 0 or more, got "${flag}"`);
  }
  return depth;
}

/** One line describing how a command was judged, for `check --explain`. */
function formatStep(step: DecisionStep): string {
  const by = stepSource(step);
  const note =
    step.reason === "unsplittable" ? " (line not fully parsed, so asks)" : "";
  const hidden = step.hidden === true ? " (hidden)" : "";
  return `${step.decision}\t${step.command}\t${by}${hidden}${note}`;
}

async function checkCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      tool: { type: "string" },
      input: { type: "string" },
      "policy-file": { type: "string" },
      cwd: { type: "string" },
      branch: { type: "string" },
      remote: { type: "string" },
      env: { type: "string", multiple: true },
      depth: { type: "string" },
      actor: { type: "string" },
      role: { type: "string", multiple: true },
      explain: { type: "boolean" },
    },
    strict: true,
  });

  if (!values.tool) error("--tool is required");
  if (values.input === undefined) error("--input is required");

  const inputPath = resolveInputSpec(values["policy-file"]);
  const source = inputPath ?? "stdin";

  const raw = await readInput(inputPath);
  const parsed = parseJson(raw, source);
  if (!parsed.ok) error(parsed.error);
  const json = parsed.value;

  try {
    const ctx: CheckContext = {};
    if (values.cwd !== undefined) ctx.cwd = values.cwd;
    if (values.branch !== undefined) ctx.branch = values.branch;
    if (values.remote !== undefined) ctx.remote = values.remote;
    if (values.env !== undefined) ctx.env = parseEnvFlags(values.env);
    if (values.depth !== undefined) ctx.depth = parseDepthFlag(values.depth);
    if (values.actor !== undefined) ctx.actor = values.actor;
    if (values.role !== undefined) ctx.roles = values.role;
    const result = checkApi(values.tool, values.input, json, ctx);
    process.stdout.write(`${result.decision}\n`);
    if (values.explain) {
      for (const step of result.steps) {
        process.stderr.write(`${formatStep(step)}\n`);
      }
    }
    process.exit(result.decision === "deny" ? 1 : 0);
  } catch (e) {
    if (e instanceof ConvertError) {
      process.stderr.write(`error: ${e.message}\n`);
      for (const err of e.errors) {
        process.stderr.write(`  ${err.path}: ${err.message}\n`);
      }
      process.exit(2);
    }
    const message = e instanceof Error ? e.message : String(e);
    error(message);
  }
}

// ---------------------------------------------------------------------------
// replay / suggest
// ---------------------------------------------------------------------------

/** Report a policy or transcript the command cannot read, and exit. */
function inputError(e: unknown): never {
  if (e instanceof ConvertError) {
    process.stderr.write(`error: ${e.message}\n`);
    for (const err of e.errors) {
      process.stderr.write(`  ${err.path}: ${err.message}\n`);
    }
    process.exit(2);
  }
  error(e instanceof Error ? e.message : String(e));
}

/** Read a policy spec as parsed JSON, exiting on unreadable input. */
async function readPolicy(spec: string | undefined): Promise<unknown> {
  const inputPath = resolveInputSpec(spec);
  const parsed = parseJson(await readInput(inputPath), inputPath ?? "stdin");
  if (!parsed.ok) error(parsed.error);
  return parsed.value;
}

/** Read a transcript file, or stdin for "-". */
function readTranscript(spec: string): Promise<string> {
  return readInput(spec === "-" ? undefined : resolve(spec));
}

async function replayCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "policy-file": { type: "string" },
      transcript: { type: "string" },
    },
    strict: true,
  });

  if (values.transcript === undefined) error("--transcript is required");
  // An omitted --policy-file reads stdin, as it does for check.
  if (
    values.transcript === "-" &&
    (values["policy-file"] === undefined || values["policy-file"] === "-")
  ) {
    error("--transcript and --policy-file cannot both be read from stdin");
  }

  const policy = await readPolicy(values["policy-file"]);
  const transcript = await readTranscript(values.transcript);
  try {
    const report = replayApi(policy, transcript);
    let out = "";
    for (const [decision, count] of Object.entries(report.counts)) {
      out += `${decision}\t${String(count)}\n`;
    }
    if (report.differing.length > 0) {
      out += "\ndiffers from the transcript:\n";
      for (const { call, decision } of report.differing) {
        out += `${decision}\t${call.outcome ?? ""}\t${call.tool}\t${call.subject ?? ""}\n`;
      }
    }
    process.stdout.write(out);
  } catch (e) {
    inputError(e);
  }
}

async function suggestCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      transcript: { type: "string" },
      "policy-file": { type: "string" },
      // Approved more than once is what makes a call repeated.
      "min-count": { type: "string", default: "2" },
    },
    strict: true,
  });

  if (values.transcript === undefined) error("--transcript is required");
  const minCount = Number(values["min-count"]);
  if (!Number.isInteger(minCount) || minCount < 1) {
    error("--min-count must be a positive integer");
  }
  if (values.transcript === "-" && values["policy-file"] === "-") {
    error("--transcript and --policy-file cannot both be read from stdin");
  }

  const policy =
    values["policy-file"] === undefined
      ? undefined
      : await readPolicy(values["policy-file"]);
  const transcript = await readTranscript(values.transcript);
  try {
    const suggestions = suggestApi(transcript, {
      minCount,
      ...(policy === undefined ? {} : { policy }),
    });
    const rules = suggestions.map((s) => s.rule);
    process.stdout.write(JSON.stringify({ rules }, null, 2) + "\n");
    for (const { rule, count } of suggestions) {
      process.stderr.write(`${String(count)}\t${ruleToString(rule)}\n`);
    }
  } catch (e) {
    inputError(e);
  }
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

async function syncCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "working-dir": { type: "string", short: "d" },
      up: { type: "string", default: "all", short: "u" },
      with: { type: "string", multiple: true, short: "w" },
      without: { type: "string", multiple: true, short: "x" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      create: { type: "boolean", short: "c" },
      verbose: { type: "boolean", short: "v" },
      backup: { type: "boolean", short: "b" },
    },
    strict: true,
  });

  // Parse --up value
  let up: number;
  if (values.up === "all") {
    up = Infinity;
  } else {
    up = Number(values.up);
    if (!Number.isInteger(up) || up < 0) {
      error("--up must be a non-negative integer or 'all'");
    }
  }

  // Merge --with and --include (aliases)
  const withRaw = allStrings(values.with, values.include);
  // Merge --without and --exclude (aliases)
  const withoutRaw = allStrings(values.without, values.exclude);

  if (withRaw.length > 0 && withoutRaw.length > 0) {
    error("--with and --without are mutually exclusive");
  }

  // Validate agent names
  const withAgents: Agent[] = [];
  for (const w of withRaw) {
    if (w === "canonical") continue;
    if (!isAgent(w))
      error(
        `unknown agent: ${w}. Valid: ${[...AGENTS, "canonical"].join(", ")}`,
      );
    withAgents.push(w);
  }

  const withoutAgents: Agent[] = [];
  for (const w of withoutRaw) {
    if (w === "canonical") continue;
    if (!isAgent(w))
      error(
        `unknown agent: ${w}. Valid: ${[...AGENTS, "canonical"].join(", ")}`,
      );
    withoutAgents.push(w);
  }

  const cwd = values["working-dir"]
    ? resolve(values["working-dir"])
    : process.cwd();

  const result = await sync({
    cwd,
    up,
    with: withAgents,
    without: withoutAgents,
    yes: values.yes ?? false,
    dryRun: values["dry-run"] ?? false,
    create: values.create ?? false,
    verbose: values.verbose ?? false,
    backup: values.backup ?? false,
  });
  if (result.refused.length > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// confine
// ---------------------------------------------------------------------------

function isOutsideBehaviour(value: string): value is OutsideBehaviour {
  return value === "ask" || value === "deny";
}

async function confineCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: "string", short: "r", multiple: true },
      outside: { type: "string", default: "ask" },
      output: { type: "string", short: "o" },
      out: { type: "string" },
      compact: { type: "boolean", short: "c" },
    },
    strict: true,
  });

  const roots = allStrings(values.root);
  if (roots.length === 0) error("--root is required");
  if (!isOutsideBehaviour(values.outside)) {
    error(`--outside must be "ask" or "deny", got: ${values.outside}`);
  }

  const policy = confine({
    roots,
    cwd: process.cwd(),
    outside: values.outside,
  });
  const jsonStr =
    JSON.stringify(policy, null, values.compact ? undefined : 2) + "\n";

  const outputSpec = firstString(values.output, values.out);
  const outputPath =
    outputSpec === undefined ? undefined : resolveOutputSpec(outputSpec);
  if (outputPath) {
    await writeJsonFile(outputPath, jsonStr);
  } else {
    process.stdout.write(jsonStr);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage(stream: "stdout" | "stderr"): void {
  const target = stream === "stdout" ? process.stdout : process.stderr;
  target.write(`agent-perms — cross-agent permission policy tool

Usage:
  agent-perms convert [--from <spec>] --to <spec>
  agent-perms validate [--input <spec>]
  agent-perms check --tool <name> --input <cmd> [--policy-file <spec>]
  agent-perms replay --transcript <file> [--policy-file <spec>]
  agent-perms suggest --transcript <file> [--policy-file <spec>] [--min-count <n>]
  agent-perms confine --root <dir> [--root <dir>] [--output <file>]
  agent-perms sync

Specs: agent name, config file path, or "-" for stdin/stdout.

  Format names resolve to default config files:
    claude-code  →  .claude/settings.json
    canonical    →  .agents/permissions.json
    opencode     →  opencode.json
    kiro         →  .kiro/permissions.json
    codex        →  codex.toml
    crush        →  .crush.json

Commands:
  convert   Convert between agent formats
  validate  Validate a policy file
  check     Evaluate a tool call against a policy
  replay    Count what a policy decides for each call in a session transcript
  suggest   Propose allow rules for calls a session transcript approved repeatedly
  confine   Generate rules that confine Read, Edit and Write to directories
  sync      Detect, merge, and write agent configs (bidirectional)
  mcp       Serve the MCP sync daemon on stdio

Convert flags:
  -f, --from, --input, --in <spec>   Source (format, file, or "-" for stdin)
  -t, --to, --output, --out <spec>   Target (format, file, or "-" for stdout)
  -c, --compact                      Output compact JSON
  -v, --verbose                      Show decode/encode summary on stderr

Validate flags:
  -i, --input, --in <spec>           Policy file (format, file, or "-" for stdin)

Check flags:
  --tool <name>                      Tool name (required)
  --input <cmd>                      Tool input string (required)
  --policy-file <spec>               Policy file (format, file, or "-" for stdin)
  --cwd, --branch, --remote          Evaluation context
  --env NAME=VALUE                   Environment variable in the context (repeatable)
  --depth <n>                        Agents between the call and the top-level agent
  --actor <name>, --role <name>      Who is making the call and the roles they hold (--role repeats)
  --explain                          Print how each command was judged, to stderr

Replay flags:
  --transcript <file>                Session transcript, JSON Lines (or "-" for stdin)
  --policy-file <spec>               Policy file (format, file, or "-" for stdin)

Suggest flags:
  --transcript <file>                Session transcript, JSON Lines (or "-" for stdin)
  --policy-file <spec>               Policy whose rules exclude or already cover calls
  --min-count <n>                    Approvals a rule must cover (default: 2)
Confine flags:
  -r, --root <dir>                   Directory the file tools may reach (repeatable, required)
  --outside <ask|deny>               Outside the roots: prompt (default) or refuse
  -o, --output, --out <spec>         Write to a file instead of stdout
  -c, --compact                      Output compact JSON
  Confine is a convenience, not a sandbox: only Read, Edit and Write are constrained, and a Bash
  command can still reach outside the roots. Use the policy's sandbox field to enforce that. The
  default mode set for --outside applies to every tool with no rule of its own, not only file tools.

Sync flags:
  -d, --working-dir <path>           Starting directory (default: cwd)
  -u, --up <n|all>                   Ascend n parent directories (default: all)
  -w, --with <agent>                 Only sync these agents (repeatable)
  -x, --without <agent>              Sync all except these agents (repeatable)
  -y, --yes                          Apply without prompting
  --dry-run                          Show changes only, never write
  -c, --create                       Create config files that don't exist
  -v, --verbose                      Show rule provenance
  -b, --backup                       Write .bak files before overwriting

Mcp flags:
  --permission-prompt                Expose the permission_prompt tool

Examples:
  agent-perms convert --from claude-code --to canonical
  agent-perms convert --from .claude/settings.json --to crush
  agent-perms convert --from claude-code --to -
  cat settings.json | agent-perms convert --from - --to canonical --output -
  agent-perms validate --input canonical
  agent-perms validate --input .agents/permissions.json
  agent-perms check --tool Bash --input "git status" --policy-file canonical
  agent-perms replay --transcript session.jsonl --policy-file canonical
  agent-perms suggest --transcript session.jsonl --policy-file canonical
  agent-perms confine --root . --root ../shared --output .agents/permissions.json
  agent-perms sync
  agent-perms sync -y
  agent-perms sync --dry-run
  agent-perms sync -w claude-code -w opencode
  agent-perms sync -x codex
  agent-perms sync -w claude-code --create
  agent-perms mcp --permission-prompt
`);
}

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

async function mcpCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { "permission-prompt": { type: "boolean" } },
    strict: true,
  });
  // Loaded on demand so the other commands never pull in the MCP SDK.
  const { startMcpServer } = await import("./mcp.ts");
  await startMcpServer(
    values["permission-prompt"] === true ? { permissionPrompt: {} } : {},
  );
}

async function main(): Promise<void> {
  // If invoked as agent-perms-mcp, route directly to MCP server
  const binName = process.argv[1]?.split("/").pop() ?? "";
  if (binName === "agent-perms-mcp") {
    await mcpCommand(process.argv.slice(2));
    return;
  }

  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "convert":
      await convertCommand(args.slice(1));
      break;
    case "validate":
      await validateCommand(args.slice(1));
      break;
    case "check":
      await checkCommand(args.slice(1));
      break;
    case "replay":
      await replayCommand(args.slice(1));
      break;
    case "suggest":
      await suggestCommand(args.slice(1));
      break;
    case "confine":
      await confineCommand(args.slice(1));
      break;
    case "sync":
      await syncCommand(args.slice(1));
      break;
    case "mcp":
      await mcpCommand(args.slice(1));
      break;
    case "--help":
    case "-h":
      // An explicit help request is a successful invocation: usage on stdout, exit 0.
      usage("stdout");
      return;
    default:
      if (command) {
        process.stderr.write(`unknown command: ${command}\n\n`);
      }
      usage("stderr");
      process.exit(1);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(
    `fatal: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
