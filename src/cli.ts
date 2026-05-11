#!/usr/bin/env node
/**
 * agent-perms CLI — convert and validate cross-agent permission policies.
 *
 * Commands:
 *   agent-perms convert --from <agent> --to <agent> [file]
 *   agent-perms validate [file]
 *   agent-perms check --tool <name> --input <string> [file]
 *
 * Reads from file argument or stdin. Writes JSON to stdout.
 * Exit codes: 0 = success, 1 = error, 2 = validation failure.
 */

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AgentPermissionPolicy } from "./schema.ts";
import { CODECS, agentId, type AgentId } from "./compat/codecs.ts";
import { evaluate, normaliseStringRule } from "./evaluate.ts";
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

// ---------------------------------------------------------------------------
// Format auto-detection
// ---------------------------------------------------------------------------

/**
 * Detect the agent format from the parsed JSON content.
 *
 * Distinguishing features:
 *   canonical — `rules` array of {tool, tier} objects, or top-level `permissions`, `sandbox`, `profiles`, etc.
 *   claude-code — `allow`/`deny`/`ask` arrays of plain strings, `additionalDirectories`
 *   crush — `allowed_tools` (required) array of plain strings
 *   kiro — `allowedTools` or `toolsSettings`
 *   codex — `approval_policy`, `sandbox_mode`, `permissions` (record of named profiles)
 *   opencode — bare "allow"/"deny" string, or object with lowercase tool keys (bash, read, edit, ...)
 */
function detectFormat(
  value: unknown,
): (typeof AGENTS)[number] | "canonical" | undefined {
  if (typeof value === "string") {
    if (value === "allow" || value === "deny") return "opencode";
    return undefined;
  }

  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;

  // Crush: required allowed_tools array
  if (Array.isArray(obj.allowed_tools)) return "crush";

  // Kiro: allowedTools or toolsSettings
  if (Array.isArray(obj.allowedTools) || "toolsSettings" in obj) return "kiro";

  // Codex: approval_policy, sandbox_mode, or permissions as record of named profiles
  if (
    "approval_policy" in obj ||
    "sandbox_mode" in obj ||
    "default_permissions" in obj
  ) {
    return "codex";
  }

  // Claude Code: allow/deny/ask arrays of strings, additionalDirectories
  if (
    ("allow" in obj && Array.isArray(obj.allow)) ||
    ("deny" in obj && Array.isArray(obj.deny)) ||
    ("ask" in obj && Array.isArray(obj.ask))
  ) {
    // Distinguish from canonical: Claude Code arrays contain plain strings,
    // canonical `rules` contains objects with {tool, tier}
    if (Array.isArray(obj.allow) && typeof obj.allow[0] === "string")
      return "claude-code";
  }

  // Canonical: rules array of {tool, tier} objects
  if (Array.isArray(obj.rules)) {
    const first: unknown = obj.rules[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "tool" in first &&
      "tier" in first
    ) {
      return "canonical";
    }
  }

  // Canonical: top-level keys like sandbox, profiles, delegation, network
  if (
    "sandbox" in obj ||
    "profiles" in obj ||
    "delegation" in obj ||
    "network" in obj ||
    "activeProfile" in obj
  ) {
    return "canonical";
  }

  // Canonical: permissions with allow/deny/ask containing string rules
  if (typeof obj.permissions === "object" && obj.permissions !== null) {
    const perms = obj.permissions as Record<string, unknown>;
    if (
      ("allow" in perms && typeof perms.allow !== "undefined") ||
      ("deny" in perms && typeof perms.deny !== "undefined")
    ) {
      return "canonical";
    }
  }

  // OpenCode: object with lowercase tool keys
  const ocTools = new Set([
    "bash",
    "read",
    "edit",
    "glob",
    "grep",
    "list",
    "task",
    "external_directory",
    "todowrite",
    "question",
    "webfetch",
    "websearch",
    "lsp",
    "doom_loop",
    "skill",
  ]);
  for (const key of Object.keys(obj)) {
    if (ocTools.has(key)) return "opencode";
  }

  // Fallback: if there's a `permissions` key with `defaultMode`, likely canonical
  if ("defaultMode" in obj) return "canonical";

  return undefined;
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

  // --input is alias for --from, --output is alias for --to
  const from = values.from ?? values.input;
  const to = values.to ?? values.output;
  if (typeof to !== "string") error("--to is required");
  const filePath = positionals[0];

  if (to !== "canonical" && !AGENTS.includes(to as Agent))
    error(
      `unknown --to agent: ${to}. Valid: ${[...AGENTS, "canonical"].join(", ")}`,
    );

  // Validate --from if explicitly provided (before reading input)
  if (
    typeof from === "string" &&
    from !== "canonical" &&
    !AGENTS.includes(from as Agent)
  )
    error(
      `unknown --from agent: ${from}. Valid: ${[...AGENTS, "canonical"].join(", ")}`,
    );

  const raw = await readInput(filePath);
  const json = parseJson(raw, filePath ?? "stdin");

  // Auto-detect --from if not specified
  let fromAgent: string;
  if (typeof from === "string") {
    fromAgent = from;
  } else {
    const detected = detectFormat(json);
    if (!detected) {
      error(
        "could not auto-detect input format. Use --from to specify (claude-code | codex | kiro | opencode | crush | canonical)",
      );
    }
    fromAgent = detected;
    if (values.verbose) {
      process.stderr.write(`Auto-detected input format: ${fromAgent}\n`);
    }
  }

  if (fromAgent !== "canonical" && !AGENTS.includes(fromAgent as Agent))
    error(
      `unknown --from agent: ${fromAgent}. Valid: ${[...AGENTS, "canonical"].join(", ")}`,
    );

  // Decode: agent-native → canonical
  let canonical: unknown;
  if (fromAgent === "canonical") {
    const result = AgentPermissionPolicy.safeParse(json);
    if (!result.success) {
      process.stderr.write("validation errors:\n");
      for (const issue of result.error.issues) {
        process.stderr.write(`  ${issue.path.join(".")}: ${issue.message}\n`);
      }
      process.exit(2);
    }
    canonical = result.data;
  } else {
    const codec = CODECS[fromAgent as Agent];
    try {
      // Input is unknown JSON from a file — codec validates at runtime
      canonical = (
        codec as {
          decode: (input: unknown) => unknown;
        }
      ).decode(json);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error(`decode failed: ${message}`);
    }
  }

  // Encode: canonical → agent-native
  let output: unknown;
  if (to === "canonical") {
    output = canonical;
  } else {
    const codec = CODECS[to as Agent];
    try {
      output = codec.encode(canonical as Parameters<typeof codec.encode>[0]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error(`encode failed: ${message}`);
    }
  }

  const indent = values.compact ? undefined : 2;
  const jsonStr = JSON.stringify(output, null, indent) + "\n";

  // Write to file (--out) or stdout
  const outFile =
    typeof values.out === "string" ? resolve(values.out) : undefined;
  if (outFile) {
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, jsonStr);
  } else {
    process.stdout.write(jsonStr);
  }

  if (values.verbose) {
    const allRules =
      canonical !== null &&
      typeof canonical === "object" &&
      "rules" in (canonical as Record<string, unknown>)
        ? ((canonical as Record<string, unknown>).rules as unknown[]).length
        : 0;
    const dest = outFile ?? "stdout";
    process.stderr.write(
      `Decoded ${fromAgent} → canonical (${String(allRules)} rules), encoded → ${to}, wrote ${dest}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

async function validateCommand(args: string[]): Promise<void> {
  const filePath = args[0];
  const raw = await readInput(filePath);
  const json = parseJson(raw, filePath ?? "stdin");

  const result = AgentPermissionPolicy.safeParse(json);
  if (result.success) {
    process.stdout.write("valid\n");
    return;
  }

  process.stderr.write("validation errors:\n");
  for (const issue of result.error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    process.stderr.write(`  ${path}: ${issue.message}\n`);
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

  const result = AgentPermissionPolicy.safeParse(json);
  if (!result.success) {
    process.stderr.write("policy is invalid, cannot check\n");
    process.exit(2);
  }

  const policy = result.data;

  // Build PermissionPolicy from the canonical data
  const rules: {
    tool: string;
    pattern?: string | undefined;
    tier: "allow" | "deny" | "ask";
  }[] = [];

  // Normalise permissions string arrays into rules
  if (policy.permissions) {
    if (policy.permissions.deny) {
      rules.push(
        ...policy.permissions.deny.map((r) => normaliseStringRule(r, "deny")),
      );
    }
    if (policy.permissions.ask) {
      rules.push(
        ...policy.permissions.ask.map((r) => normaliseStringRule(r, "ask")),
      );
    }
    if (policy.permissions.allow) {
      rules.push(
        ...policy.permissions.allow.map((r) => normaliseStringRule(r, "allow")),
      );
    }
  }

  // Merge structured rules
  if (policy.rules) {
    rules.push(...policy.rules);
  }

  const mode = policy.defaultMode ?? "standard";
  const mappedMode =
    mode === "autonomous" || mode === "bypassPermissions" || mode === "dontAsk"
      ? "autonomous"
      : mode === "restricted" || mode === "plan"
        ? "restricted"
        : mode === "readonly"
          ? "readonly"
          : "standard";

  const decision = evaluate(
    { defaultMode: mappedMode, rules },
    values.tool,
    values.input,
    { cwd: values.cwd, branch: values.branch } as {
      cwd?: string;
      branch?: string;
    },
  );

  process.stdout.write(`${decision}\n`);
  process.exit(decision === "deny" ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
  const withAgents: AgentId[] = [];
  for (const w of withRaw) {
    if (w !== "canonical" && !AGENTS.includes(w as Agent)) {
      error(
        `unknown agent: ${w}. Valid: ${[...AGENTS, "canonical"].join(", ")}`,
      );
    }
    withAgents.push(w as AgentId);
  }

  const withoutAgents: AgentId[] = [];
  for (const w of withoutRaw) {
    if (w !== "canonical" && !AGENTS.includes(w as Agent)) {
      error(
        `unknown agent: ${w}. Valid: ${[...AGENTS, "canonical"].join(", ")}`,
      );
    }
    withoutAgents.push(w as AgentId);
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

function usage(): never {
  process.stderr.write(`agent-perms — cross-agent permission policy tool

Usage:
  agent-perms convert --from <agent> --to <agent> [file]
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
  -f, --from, --input <agent>   Source agent format (auto-detected if omitted)
  -t, --to, --output <agent>    Target agent format (required)
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
  agent-perms convert --input claude-code --output canonical .claude/settings.json
  agent-perms sync                                        # detect all, merge, prompt
  agent-perms sync -y                                     # apply immediately
  agent-perms sync --dry-run                              # preview only
  agent-perms sync --include claude-code --include opencode
  agent-perms sync --without codex                        # all except codex
  agent-perms sync --include claude-code --create         # bootstrap .claude/settings.json
  agent-perms sync --up 0                                 # cwd only, no parent walk
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
