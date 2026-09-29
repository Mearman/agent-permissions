/**
 * Programmatic API for agent-perms — side-effect-free functions for converting, validating, and
 * checking permission policies, and for replaying them over recorded sessions.
 *
 * Import: import { convert, validate, check, replay, suggest, detectFormat } from "agent-perms/api";
 */

import {
  CODECS,
  CODEX_EXECPOLICY_RULES_PATH,
  agentId,
  encodeCodex,
  type AgentId,
} from "./compat/codecs.ts";
import {
  explain,
  collectRules,
  delegationLimits,
  mapMode,
  type DecisionStep,
  type EvaluationContext,
  type PermissionPolicy,
} from "./evaluate.ts";
import {
  parseTranscript,
  replayCalls,
  suggestRules,
  type ReplayReport,
  type Suggestion,
} from "./replay.ts";
import { validatePolicy, type ValidationError } from "./agent-files.ts";
import { isAgentId, isRecord } from "./guards.ts";
import { AgentPermissionPolicy } from "./schema.ts";
export type { ValidationError } from "./agent-files.ts";
import { basename } from "node:path";

const AGENTS = agentId.options;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported format identifiers, including canonical. */
export type Format = AgentId | "canonical";

/** Result of a successful conversion. */
export interface ConvertResult {
  /** The converted output (agent-native JSON object). */
  output: unknown;
  /** The format that was decoded from (auto-detected or explicit). */
  from: Format;
  /** Number of rules in the intermediate canonical representation. */
  ruleCount: number;
  /** Further files the target needs beside its config, such as Codex's execpolicy rules file. */
  companions: CompanionFile[];
}

/** A file written beside a converted config. */
export interface CompanionFile {
  /** Path relative to the directory holding the converted config. */
  path: string;
  content: string;
}

/** Result of validating a policy. */
export interface ValidateResult {
  /** Whether the policy is valid. */
  valid: boolean;
  /** Validation errors (empty when valid). */
  errors: ValidationError[];
}

/** The facts about the call that a rule's `when` conditions are checked against. */
export type CheckContext = EvaluationContext;

/** Result of checking a tool call against a policy. */
export interface CheckResult {
  /** The evaluation decision. */
  decision: "allow" | "deny" | "ask";
  /** How each command was judged: the matching rule, or the default mode. */
  steps: DecisionStep[];
  /** Whether a `hidden` deny rule matched, so the host should leave the tool out of its list. */
  hidden: boolean;
}

// ---------------------------------------------------------------------------
// detectFormat / detectFormatFromPath / resolveFormat
// ---------------------------------------------------------------------------

/**
 * Detect the agent format from a file path.
 *
 * Matches against known config file names:
 *
 * - `.claude/settings.json` or `.claude/settings.local.json` → claude-code
 * - `opencode.json` → opencode
 * - `.kiro/permissions.json` → kiro
 * - `codex.toml` → codex
 * - `.agents/permissions.json` or `.agents/permissions.local.json` → canonical
 */
export function detectFormatFromPath(filePath: string): Format | undefined {
  const base = basename(filePath);
  const dir = filePath.replace(/\\/g, "/");

  // Check directory-qualified paths first
  if (
    dir.endsWith("/.claude/settings.json") ||
    dir.endsWith("/.claude/settings.local.json")
  ) {
    return "claude-code";
  }
  if (
    dir.endsWith("/.agents/permissions.json") ||
    dir.endsWith("/.agents/permissions.local.json")
  ) {
    return "canonical";
  }
  if (dir.endsWith("/.kiro/permissions.json")) return "kiro";

  // Check basenames
  if (base === "opencode.json") return "opencode";
  if (base === "codex.toml") return "codex";
  if (base === ".crush.json") return "crush";
  if (dir.endsWith("/.omp/agent/config.yml")) return "omp";

  return undefined;
}

/**
 * Resolve a format specifier that may be an agent name or a file path.
 *
 * Returns the format if it's a known agent name. Returns the detected format if it's a known config
 * file path. Returns undefined if neither.
 */
export function resolveFormat(spec: string): Format | undefined {
  // Check agent names first
  if (spec === "canonical" || isAgentId(spec)) {
    return spec;
  }

  // Try file path detection
  return detectFormatFromPath(spec);
}

/**
 * Detect the agent format from parsed JSON content.
 *
 * Distinguishing features: canonical — `rules` array of {tool, tier} objects, or top-level
 * `permissions`, `sandbox`, `profiles`, etc. claude-code — `allow`/`deny`/`ask` arrays of plain
 * strings, `additionalDirectories` crush — `allowed_tools` (required) array of plain strings kiro —
 * `allowedTools` or `toolsSettings` codex — `approval_policy`, `sandbox_mode`, `permissions`
 * (record of named profiles) opencode — bare "allow"/"deny" string, or object with lowercase tool
 * keys (bash, read, edit, …)
 */
export function detectFormat(value: unknown): Format | undefined {
  if (typeof value === "string") {
    if (value === "allow" || value === "deny") return "opencode";
    return undefined;
  }

  if (!isRecord(value)) return undefined;
  const obj = value;

  // Crush: required allowed_tools array
  if (Array.isArray(obj.allowed_tools)) return "crush";

  // Kiro: allowedTools or toolsSettings
  if (Array.isArray(obj.allowedTools) || "toolsSettings" in obj) return "kiro";

  // OMP: bash.patterns, an array of { match, approval } entries. Checked before OpenCode, whose
  // bash key is a string or an object of patterns.
  if (
    isRecord(obj.bash) &&
    Array.isArray(obj.bash.patterns) &&
    obj.bash.patterns.every(
      (entry) => isRecord(entry) && "match" in entry && "approval" in entry,
    )
  ) {
    return "omp";
  }

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
    const check = (arr: unknown): boolean =>
      Array.isArray(arr) && arr.length > 0 && typeof arr[0] === "string";
    if (check(obj.allow) || check(obj.deny) || check(obj.ask))
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
  if (isRecord(obj.permissions)) {
    const perms = obj.permissions;
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

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

/**
 * Convert a permission config between agent formats.
 *
 * @param from - Source format. Omit or `undefined` to auto-detect.
 * @param to - Target format (required).
 * @param json - Parsed JSON input (any agent-native or canonical object).
 *
 * @returns Conversion result with output, detected format, and rule count.
 *
 * @throws Error on invalid input, unknown format, or codec failure.
 */
export function convert(
  from: Format | undefined,
  to: Format,
  json: unknown,
): ConvertResult {
  // Auto-detect --from
  let fromAgent: Format;
  if (from !== undefined) {
    fromAgent = from;
  } else {
    const detected = detectFormat(json);
    if (!detected) {
      throw new Error(
        "could not auto-detect input format. Specify from explicitly.",
      );
    }
    fromAgent = detected;
  }

  // Validate formats
  if (fromAgent !== "canonical" && !AGENTS.includes(fromAgent)) {
    throw new TypeError(
      `unknown from format: ${fromAgent}. Valid: ${[...AGENTS, "canonical"].join(", ")}`,
    );
  }
  if (to !== "canonical" && !AGENTS.includes(to)) {
    throw new TypeError(
      `unknown to format: ${to}. Valid: ${[...AGENTS, "canonical"].join(", ")}`,
    );
  }

  // Decode: agent-native → canonical
  let canonical: AgentPermissionPolicy;
  if (fromAgent === "canonical") {
    const result = validatePolicy(json);
    if (!result.ok) throw new ConvertError(result.error, result.errors);
    canonical = result.value;
  } else {
    const codec = CODECS[fromAgent];
    // The decoded agent config is unknown-shaped here while the zod codec's decode is typed for its own native input — a config of the wrong shape throws inside decode.
    // @ts-expect-error unknown JSON passed to a native-typed decode; invalid shapes throw and surface as conversion errors
    canonical = codec.decode(json);
    const validated = validatePolicy(canonical);
    if (!validated.ok)
      throw new ConvertError(validated.error, validated.errors);
    canonical = validated.value;
  }

  // Count rules in intermediate canonical form
  const ruleCount = countRules(canonical);

  // Encode: canonical → agent-native
  let output: unknown;
  const companions: CompanionFile[] = [];
  if (to === "canonical") {
    // Inject $schema so generated files get IDE support
    const schemaUrl =
      "https://github.com/Mearman/agent-permissions/releases/latest/download/agent-permissions.schema.json";
    output = { $schema: schemaUrl, ...canonical };
  } else if (to === "codex") {
    const { config, rules } = encodeCodex(canonical);
    output = config;
    if (rules !== undefined) {
      companions.push({ path: CODEX_EXECPOLICY_RULES_PATH, content: rules });
    }
  } else {
    const codec = CODECS[to];
    output = codec.encode(canonical);
  }

  return { output, from: fromAgent, ruleCount, companions };
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON object against the canonical policy schema.
 *
 * @param json - Parsed JSON to validate.
 *
 * @returns Validation result with errors array (empty when valid).
 */
export function validate(json: unknown): ValidateResult {
  const result = validatePolicy(json);
  if (result.ok) return { valid: true, errors: [] };
  return { valid: false, errors: result.errors };
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/**
 * Evaluate a tool call against a canonical policy.
 *
 * @param tool - Tool name (e.g. "Bash", "Read").
 * @param input - Tool input string to match against patterns.
 * @param json - Parsed canonical policy JSON.
 * @param context - Optional evaluation context (cwd, branch, remote, env, depth).
 *
 * @returns Check result with the evaluation decision.
 *
 * @throws Error if the policy is invalid.
 */
export function check(
  tool: string,
  input: string,
  json: unknown,
  context?: CheckContext,
): CheckResult {
  const { decision, steps, hidden } = explain(
    permissionPolicy(json),
    tool,
    input,
    context,
  );

  return { decision, steps, hidden };
}

// ---------------------------------------------------------------------------
// replay / suggest
// ---------------------------------------------------------------------------

/**
 * Replay a policy over a recorded session transcript.
 *
 * @param json - Parsed canonical policy JSON.
 * @param transcript - The transcript's JSON Lines text (see `agent-perms/replay` for the fields read).
 *
 * @returns How many calls the policy would allow, ask about and deny, and the calls whose recorded outcome it could not have produced.
 *
 * @throws {ConvertError} If the policy is invalid.
 * @throws {SyntaxError} If a transcript line is not JSON.
 */
export function replay(json: unknown, transcript: string): ReplayReport {
  return replayCalls(permissionPolicy(json), parseTranscript(transcript));
}

/** Options for {@link suggest}. */
export interface SuggestOptions {
  /** How many approved calls a rule must cover to be proposed. */
  minCount: number;
  /** Parsed canonical policy JSON whose deny rules exclude commands and whose allow rules make a proposal unnecessary. */
  policy?: unknown;
}

/**
 * Propose allow rules for calls a recorded session shows were approved repeatedly.
 *
 * @param transcript - The transcript's JSON Lines text (see `agent-perms/replay` for the fields read).
 *
 * @returns The proposed rules, each with how many approved calls it covers.
 *
 * @throws {ConvertError} If the policy is invalid.
 * @throws {SyntaxError} If a transcript line is not JSON.
 */
export function suggest(
  transcript: string,
  options: SuggestOptions,
): Suggestion[] {
  return suggestRules(
    parseTranscript(transcript),
    permissionPolicy(options.policy ?? {}),
    options.minCount,
  );
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Error thrown when conversion or validation fails. */
export class ConvertError extends Error {
  /** Validation errors that caused the failure. */
  readonly errors: ValidationError[];

  constructor(message: string, errors: ValidationError[]) {
    super(message);
    this.name = "ConvertError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate a canonical policy and flatten it into the form the evaluator takes.
 *
 * @throws {ConvertError} If the policy is invalid.
 */
function permissionPolicy(json: unknown): PermissionPolicy {
  const result = validatePolicy(json);
  if (!result.ok) throw new ConvertError(result.error, result.errors);
  const policy = result.value;
  const delegation = delegationLimits(policy.delegation);
  return {
    defaultMode: mapMode(policy.defaultMode ?? "standard"),
    rules: collectRules(policy),
    ...(delegation === undefined ? {} : { delegation }),
  };
}

function countRules(canonical: unknown): number {
  if (isRecord(canonical) && Array.isArray(canonical.rules)) {
    return canonical.rules.length;
  }
  return 0;
}
