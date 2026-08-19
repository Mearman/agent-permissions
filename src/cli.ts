#!/usr/bin/env node
/**
 * agent-perms CLI — convert, validate, check, and sync cross-agent permission policies.
 *
 * All flags, no positionals. Format names resolve to default config file locations.
 * Use "-" for stdin/stdout.
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
  resolveFormat,
  ConvertError,
  type Format,
} from "./api.ts";
import { agentId } from "./compat/codecs.ts";
import { sync } from "./sync.ts";
import {
  AGENT_FILES,
  findDefaultFile,
  readInput,
  parseJson,
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
  return AGENTS.includes(value as Agent);
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/** Resolve a spec to an input file path. Format name → walk up, file path → direct, "-" → stdin. */
function resolveInputSpec(spec: string | undefined): string | undefined {
  if (spec === undefined || spec === "-") return undefined;
  const format = resolveFormat(spec);
  if (format === "omp" && spec !== "omp") return resolve(spec);
  if (format) return findDefaultFile(format, process.cwd());
  return resolve(spec);
}

/** Resolve a spec to an output file path. Format name → cwd, file path → direct, "-" → stdout. */
function resolveOutputSpec(spec: string | undefined): string | undefined {
  if (spec === undefined || spec === "-") return undefined;
  const format = resolveFormat(spec);
  if (format === "omp" && spec !== "omp") return resolve(spec);
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
      `unknown --to format: ${toSpec}. Use an agent name (claude-code, codex, kiro, opencode, crush, canonical), a config file path, or "-" for stdout`,
    );
  }
  const outputPath = outputSpec
    ? resolveOutputSpec(outputSpec)
    : resolveOutputSpec(toSpec);

  // No need to validate --from — auto-detect handles unknown file paths

  const source = inputPath ?? "stdin";
  const raw = await readInput(inputPath);
  const parsed = parseJson(raw, source);
  if (!parsed.ok) error(parsed.error);
  const json = parsed.value;

  try {
    const result = convert(fromFormat, toFormat, json);

    const indent = values.compact ? undefined : 2;
    const jsonStr = JSON.stringify(result.output, null, indent) + "\n";

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

async function checkCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      tool: { type: "string" },
      input: { type: "string" },
      "policy-file": { type: "string" },
      cwd: { type: "string" },
      branch: { type: "string" },
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
    const ctx: { cwd?: string; branch?: string } = {};
    if (values.cwd !== undefined) ctx.cwd = values.cwd;
    if (values.branch !== undefined) ctx.branch = values.branch;
    const result = checkApi(values.tool, values.input, json, ctx);
    process.stdout.write(`${result.decision}\n`);
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

  await sync({
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
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage(): never {
  process.stderr.write(`agent-perms — cross-agent permission policy tool

Usage:
  agent-perms convert [--from <spec>] --to <spec>
  agent-perms validate [--input <spec>]
  agent-perms check --tool <name> --input <cmd> [--policy-file <spec>]
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
  sync      Detect, merge, and write agent configs (bidirectional)

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
  --cwd, --branch                    Evaluation context

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

Examples:
  agent-perms convert --from claude-code --to canonical
  agent-perms convert --from .claude/settings.json --to crush
  agent-perms convert --from claude-code --to -
  cat settings.json | agent-perms convert --from - --to canonical --output -
  agent-perms validate --input canonical
  agent-perms validate --input .agents/permissions.json
  agent-perms check --tool Bash --input "git status" --policy-file canonical
  agent-perms sync
  agent-perms sync -y
  agent-perms sync --dry-run
  agent-perms sync -w claude-code -w opencode
  agent-perms sync -x codex
  agent-perms sync -w claude-code --create
`);
  process.exit(1);
}

async function main(): Promise<void> {
  // If invoked as agent-perms-mcp, route directly to MCP server
  const binName = process.argv[1]?.split("/").pop() ?? "";
  if (binName === "agent-perms-mcp") {
    await import("./mcp.ts");
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
    case "sync":
      await syncCommand(args.slice(1));
      break;
    case "mcp":
      await import("./mcp.ts");
      break;
    case "--help":
    case "-h":
      usage();
      break;
    default:
      if (command) {
        process.stderr.write(`unknown command: ${command}\n\n`);
      }
      usage();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(
    `fatal: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
