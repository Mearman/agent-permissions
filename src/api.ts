/**
 * Programmatic API for agent-perms — side-effect-free functions for
 * converting, validating, and checking permission policies.
 *
 * Import:
 *   import { convert, validate, check, detectFormat } from "agent-perms/api";
 */

import { AgentPermissionPolicy } from "./schema.ts";
import { CODECS, agentId, type AgentId } from "./compat/codecs.ts";
import { evaluate, collectRules } from "./evaluate.ts";
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
}

/** Validation error for a single field. */
export interface ValidationError {
  /** Dot-separated path to the invalid field, or "(root)". */
  path: string;
  /** Human-readable error message. */
  message: string;
}

/** Result of validating a policy. */
export interface ValidateResult {
  /** Whether the policy is valid. */
  valid: boolean;
  /** Validation errors (empty when valid). */
  errors: ValidationError[];
}

/** Result of checking a tool call against a policy. */
export interface CheckResult {
  /** The evaluation decision. */
  decision: "allow" | "deny" | "ask";
}

// ---------------------------------------------------------------------------
// detectFormat / detectFormatFromPath / resolveFormat
// ---------------------------------------------------------------------------

/**
 * Detect the agent format from a file path.
 *
 * Matches against known config file names:
 *   - `.claude/settings.json` or `.claude/settings.local.json` → claude-code
 *   - `opencode.json` → opencode
 *   - `.kiro/permissions.json` → kiro
 *   - `codex.toml` → codex
 *   - `.agents/permissions.json` or `.agents/permissions.local.json` → canonical
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

  return undefined;
}

/**
 * Resolve a format specifier that may be an agent name or a file path.
 *
 * Returns the format if it's a known agent name.
 * Returns the detected format if it's a known config file path.
 * Returns undefined if neither.
 */
export function resolveFormat(spec: string): Format | undefined {
  // Check agent names first
  if (spec === "canonical" || AGENTS.includes(spec as AgentId)) {
    return spec as Format;
  }

  // Try file path detection
  return detectFormatFromPath(spec);
}

/**
 * Detect the agent format from parsed JSON content.
 *
 * Distinguishing features:
 *   canonical — `rules` array of {tool, tier} objects, or top-level `permissions`, `sandbox`, `profiles`, etc.
 *   claude-code — `allow`/`deny`/`ask` arrays of plain strings, `additionalDirectories`
 *   crush — `allowed_tools` (required) array of plain strings
 *   kiro — `allowedTools` or `toolsSettings`
 *   codex — `approval_policy`, `sandbox_mode`, `permissions` (record of named profiles)
 *   opencode — bare "allow"/"deny" string, or object with lowercase tool keys (bash, read, edit, …)
 */
export function detectFormat(value: unknown): Format | undefined {
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

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

/**
 * Convert a permission config between agent formats.
 *
 * @param from - Source format. Omit or `undefined` to auto-detect.
 * @param to - Target format (required).
 * @param json - Parsed JSON input (any agent-native or canonical object).
 * @returns Conversion result with output, detected format, and rule count.
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
  let canonical: unknown;
  if (fromAgent === "canonical") {
    const result = AgentPermissionPolicy.safeParse(json);
    if (!result.success) {
      const errors = result.error.issues.map(
        (issue): ValidationError => ({
          path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
          message: issue.message,
        }),
      );
      throw new ConvertError("validation failed", errors);
    }
    canonical = result.data;
  } else {
    const codec = CODECS[fromAgent];
    canonical = (
      codec as {
        decode: (input: unknown) => unknown;
      }
    ).decode(json);
  }

  // Count rules in intermediate canonical form
  const ruleCount = countRules(canonical);

  // Encode: canonical → agent-native
  let output: unknown;
  if (to === "canonical") {
    output = canonical;
  } else {
    const codec = CODECS[to];
    output = codec.encode(canonical as Parameters<(typeof codec)["encode"]>[0]);
  }

  return { output, from: fromAgent, ruleCount };
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON object against the canonical policy schema.
 *
 * @param json - Parsed JSON to validate.
 * @returns Validation result with errors array (empty when valid).
 */
export function validate(json: unknown): ValidateResult {
  const result = AgentPermissionPolicy.safeParse(json);
  if (result.success) {
    return { valid: true, errors: [] };
  }

  const errors: ValidationError[] = result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));

  return { valid: false, errors };
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
 * @param context - Optional evaluation context (cwd, branch).
 * @returns Check result with the evaluation decision.
 * @throws Error if the policy is invalid.
 */
export function check(
  tool: string,
  input: string,
  json: unknown,
  context?: { cwd?: string; branch?: string },
): CheckResult {
  const result = AgentPermissionPolicy.safeParse(json);
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue): ValidationError => ({
        path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
        message: issue.message,
      }),
    );
    throw new ConvertError("policy is invalid, cannot check", errors);
  }

  const policy = result.data;

  const rules = collectRules(policy);
  const mode = policy.defaultMode ?? "standard";
  const mappedMode = mapMode(mode);

  const decision = evaluate(
    { defaultMode: mappedMode, rules },
    tool,
    input,
    context,
  );

  return { decision };
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

function countRules(canonical: unknown): number {
  if (
    canonical !== null &&
    typeof canonical === "object" &&
    "rules" in (canonical as Record<string, unknown>)
  ) {
    const rules = (canonical as Record<string, unknown>).rules;
    if (Array.isArray(rules)) return rules.length;
  }
  return 0;
}

function mapMode(
  mode: string,
): "autonomous" | "standard" | "restricted" | "readonly" {
  if (
    mode === "autonomous" ||
    mode === "bypassPermissions" ||
    mode === "dontAsk"
  ) {
    return "autonomous";
  }
  if (mode === "restricted" || mode === "plan") return "restricted";
  if (mode === "readonly") return "readonly";
  return "standard";
}
