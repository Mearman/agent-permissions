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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
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

const AGENTS = agentId.options;
type Agent = (typeof AGENTS)[number];

/** Default config file for each format, relative to cwd. */
const FORMAT_FILES: Record<Format, string> = {
  canonical: ".agents/permissions.json",
  "claude-code": ".claude/settings.json",
  codex: "codex.toml",
  opencode: "opencode.json",
  crush: ".crush.json",
  kiro: ".kiro/permissions.json",
};

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

/**
 * Resolve a spec to a file path.
 * - Format name → walk up from cwd to find the default file, fall back to cwd
 * - File path → used directly
 * - "-" → undefined (caller handles stdin/stdout)
 */
function resolveInputPath(spec: string | undefined): string | undefined {
  if (spec === undefined || spec === "-") return undefined;

  // Check if it's a format name
  const format = resolveFormat(spec);
  if (format) {
    const defaultFile = FORMAT_FILES[format];
    // Walk up from cwd to find it
    let dir = process.cwd();
    for (;;) {
      const candidate = join(dir, defaultFile);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break; // reached root
      dir = parent;
    }
    // Not found — use cwd as default location
    return join(process.cwd(), defaultFile);
  }

  // It's a file path
  return resolve(spec);
}

/**
 * Resolve a spec to an output file path.
 * - Format name → join with cwd (always write to cwd, no walk-up)
 * - File path → used directly
 * - "-" → undefined (stdout)
 */
function resolveOutputPath(spec: string | undefined): string | undefined {
  if (spec === undefined || spec === "-") return undefined;

  const format = resolveFormat(spec);
  if (format) {
    return join(process.cwd(), FORMAT_FILES[format]);
  }

  return resolve(spec);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function readInput(path: string | undefined): Promise<string> {
  if (path === undefined) return readStdin();
  return readFile(path, "utf-8");
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    error(`${source}: invalid JSON`);
  }
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
  const inputPath = resolveInputPath(fromSpec);
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
    ? resolveOutputPath(outputSpec)
    : resolveOutputPath(toSpec);

  // No need to validate --from — auto-detect handles unknown file paths

  const source = inputPath ?? "stdin";
  const raw = await readInput(inputPath);
  const json = parseJson(raw, source);

  try {
    const result = convert(fromFormat, toFormat, json);

    const indent = values.compact ? undefined : 2;
    const jsonStr = JSON.stringify(result.output, null, indent) + "\n";

    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, jsonStr);
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
  const inputPath = resolveInputPath(inputSpec);
  const source = inputPath ?? "stdin";

  const raw = await readInput(inputPath);
  const json = parseJson(raw, source);

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

  const inputPath = resolveInputPath(values["policy-file"]);
  const source = inputPath ?? "stdin";

  const raw = await readInput(inputPath);
  const json = parseJson(raw, source);

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
