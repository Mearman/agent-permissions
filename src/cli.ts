#!/usr/bin/env node
/**
 * agent-perms CLI — convert, validate, check, and sync cross-agent permission policies.
 *
 * Commands:
 *   agent-perms convert [--from <agent>] --to <agent> [file]
 *   agent-perms validate [file]
 *   agent-perms check --tool <name> --input <string> [file]
 *   agent-perms sync [path]
 *
 * Reads from file argument or stdin. Writes JSON to stdout.
 * Exit codes: 0 = success, 1 = error, 2 = validation failure.
 */

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

async function readInput(filePath: string | undefined): Promise<string> {
  if (filePath) {
    return readFile(resolve(filePath), "utf-8");
  }

  // Read from stdin
  if (process.stdin.isTTY) {
    error("no input file provided and stdin is a terminal");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    error(`${source}: invalid JSON`);
  }
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

async function convertCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      from: { type: "string", short: "f" },
      to: { type: "string", short: "t" },
      input: { type: "string" },
      output: { type: "string" },
      out: { type: "string", short: "o" },
      compact: { type: "boolean", short: "c" },
      verbose: { type: "boolean", short: "v" },
    },
    strict: false,
    allowPositionals: true,
  });

  const from = values.from ?? values.input;
  const to = values.to ?? values.output;
  if (typeof to !== "string") error("--to is required");
  const filePath = positionals[0];

  // Resolve --from and --to (agent name or file path)
  const toFormat = resolveFormat(to);
  if (!toFormat)
    error(
      `unknown --to format: ${to}. Use an agent name (claude-code, codex, kiro, opencode, crush, canonical) or a config file path`,
    );

  // If --to is a file path, use it as output file too
  const toIsFilePath = to !== "canonical" && !isAgent(to);
  const resolvedOutFile =
    typeof values.out === "string"
      ? resolve(values.out)
      : toIsFilePath
        ? resolve(to)
        : undefined;

  // Resolve --from (agent name, file path, or omitted for auto-detect)
  let fromFormat: Format | undefined;
  if (typeof from === "string") {
    fromFormat = resolveFormat(from);
    if (!fromFormat)
      error(
        `unknown --from format: ${from}. Use an agent name or a config file path`,
      );
  }

  const raw = await readInput(filePath);
  const json = parseJson(raw, filePath ?? "stdin");

  try {
    const result = convert(fromFormat, toFormat, json);

    const indent = values.compact ? undefined : 2;
    const jsonStr = JSON.stringify(result.output, null, indent) + "\n";

    const outFile = resolvedOutFile;
    if (outFile) {
      await mkdir(dirname(outFile), { recursive: true });
      await writeFile(outFile, jsonStr);
    } else {
      process.stdout.write(jsonStr);
    }

    if (values.verbose) {
      const dest = outFile ?? "stdout";
      process.stderr.write(
        `Decoded ${result.from} → canonical (${String(result.ruleCount)} rules), encoded → ${to}, wrote ${dest}\n`,
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
  const filePath = args[0];
  const raw = await readInput(filePath);
  const json = parseJson(raw, filePath ?? "stdin");

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
  const { values, positionals } = parseArgs({
    args,
    options: {
      tool: { type: "string" },
      input: { type: "string" },
      cwd: { type: "string" },
      branch: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  if (!values.tool) error("--tool is required");
  if (values.input === undefined) error("--input is required");

  const filePath = positionals[0];
  const raw = await readInput(filePath);
  const json = parseJson(raw, filePath ?? "stdin");

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
  const { values, positionals } = parseArgs({
    args,
    options: {
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
    allowPositionals: true,
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
  const withRaw = [...(values.with ?? []), ...(values.include ?? [])];
  // Merge --without and --exclude (aliases)
  const withoutRaw = [...(values.without ?? []), ...(values.exclude ?? [])];

  if (withRaw.length > 0 && withoutRaw.length > 0) {
    error("--with/--include and --without/--exclude are mutually exclusive");
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

  const cwd = positionals[0] ? resolve(positionals[0]) : process.cwd();

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
  agent-perms convert [--from <agent>] --to <agent> [file]
  agent-perms validate [file]
  agent-perms check --tool <name> --input <string> [file]
  agent-perms sync [path]

Agents: claude-code, codex, kiro, opencode, crush, canonical

Commands:
  convert   Convert a permission config between agent formats (unidirectional)
  validate  Validate a .agents/permissions.json file
  check     Evaluate a tool call against a policy
  sync      Detect, merge, and write agent permission configs (bidirectional)

Convert flags:
  -f, --from, --input <agent>   Source format (auto-detected if omitted)
  -t, --to, --output <agent>    Target format (required)
  -o, --out <file>              Write output to file instead of stdout
  -c, --compact                 Output compact JSON (no pretty-print)
  -v, --verbose                 Show decode/encode summary on stderr

Sync flags:
  -u, --up <n|all>                  Ascend n parent directories (default: all)
  -w, --with, --include <agent>     Only sync these agents (repeatable)
  -x, --without, --exclude <agent>  Sync all except these agents (repeatable)
  -y, --yes                         Apply without prompting
  -d, --dry-run                     Show changes only, never write
  -c, --create                      Create config files that don't exist
  -v, --verbose                     Show rule provenance
  -b, --backup                      Write .bak files before overwriting

Examples:
  agent-perms convert --from claude-code --to canonical .claude/settings.json
  agent-perms convert --to canonical settings.json    # auto-detect format
  agent-perms sync                                    # detect all, merge, prompt
  agent-perms sync -y                                 # apply immediately
  agent-perms sync --dry-run                          # preview only
  agent-perms sync -w claude-code -w opencode
  agent-perms sync -x codex                           # all except codex
  agent-perms sync -w claude-code --create            # bootstrap .claude/settings.json
  agent-perms sync -u 0                               # cwd only, no parent walk
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
