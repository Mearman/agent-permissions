/**
 * Permission evaluator — deny-first rule matching.
 *
 * All permission rules are unified into a single `rules` array. Each rule has a `tier`
 * (deny/ask/allow), an optional `pattern`, and optional `when` conditions.
 *
 * Evaluation order:
 *
 * 1. All deny-tier rules (any match → "deny")
 * 2. All ask-tier rules (any match → "ask")
 * 3. All allow-tier rules (any match → "allow")
 * 4. DefaultMode fallback
 *
 * Deny always short-circuits — a deny from any source cannot be overridden by an allow from any
 * source.
 *
 * Pattern syntax (Claude Code compatible):
 *
 * - Exact: `git status` — string equality
 * - Prefix: `prefix:*` — word-boundary enforced prefix match
 * - Wildcard: `pattern * middle *` — regex with `.*` for `*`
 * - Bare tool (no pattern): matches any invocation
 * - Domain: `domain:example.com` — substring match on hostname
 *
 * Plus extensions:
 *
 * - Case-insensitive tool name matching
 * - `when.cwd` / `when.branch` conditions (AND logic)
 */

import {
  hierarchicalGlobPattern,
  prefixPattern,
  wildcardPattern,
} from "trilean/derived-patterns";
import type { ExpressionNode, PredicateNode } from "trilean/tree";

import type { Rule, RuleCondition } from "./schema.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PermissionDecision = "deny" | "ask" | "allow";

export type PermissionTier = "deny" | "ask" | "allow";

export interface PermissionPolicy {
  defaultMode: "autonomous" | "standard" | "restricted" | "readonly";
  rules?: Rule[];
}

/** Context for conditional rule evaluation (cwd, branch, etc.). */
export interface EvaluationContext {
  cwd?: string;
  branch?: string;
}

// ---------------------------------------------------------------------------
// Rule normalisation — convert string rules to structured rules
// ---------------------------------------------------------------------------

/**
 * Normalise a string rule from `permissions.allow/deny/ask` into a structured Rule.
 *
 * String rule syntax:
 *
 * - `"Read"` → `{ tool: "Read", tier }`
 * - `"Bash(git status)"` → `{ tool: "Bash", pattern: "git status", tier }`
 * - `"Bash(npm:*)"` → `{ tool: "Bash", pattern: "npm:*", tier }`
 * - `"Bash()"` → `{ tool: "Bash", tier }` (match all)
 * - `"mcp__github__*"` → `{ tool: "mcp__github__*", tier }`
 */
export function normaliseStringRule(rule: string, tier: PermissionTier): Rule {
  const openIdx = findFirstUnescaped(rule, "(");
  if (openIdx === -1) {
    return { tool: rule, tier };
  }
  const closeIdx = findLastUnescaped(rule, ")");
  if (closeIdx === -1 || closeIdx <= openIdx || closeIdx !== rule.length - 1) {
    return { tool: rule, tier };
  }
  const tool = rule.slice(0, openIdx);
  if (!tool) {
    return { tool: rule, tier };
  }
  const rawContent = rule.slice(openIdx + 1, closeIdx);
  if (rawContent === "" || rawContent === "*") {
    return { tool, tier };
  }
  return { tool, pattern: rawContent, tier };
}

// ---------------------------------------------------------------------------
// Rule parsing — pattern matching
// ---------------------------------------------------------------------------

/** Parsed pattern — determines how a rule's pattern matches input. */
type ParsedPattern =
  | { type: "bare" }
  | { type: "exact"; content: string }
  | { type: "prefix"; prefix: string }
  | { type: "wildcard"; pattern: string };

// ---------------------------------------------------------------------------
// Pattern compilation — delegated to trilean's pattern builders
// ---------------------------------------------------------------------------

/**
 * The subject a compiled pattern is written against.
 *
 * trilean's builders are pure tree construction: `wildcardPattern(subject, pattern)` performs no I/O and evaluates nothing, it just returns a `textCompare` node whose right-hand `textLiteral` holds the compiled regular-expression string. Only trilean's own `evaluatePredicate`/`createEvaluator` are async, and this evaluator does not use them — it reads the compiled string back out of the node and runs it against the input itself, keeping evaluation fully synchronous. The reference key is therefore never resolved by anything; it exists because a `textCompare` node needs a left-hand expression, and naming the subject makes the node readable if one is ever logged or serialised.
 */
const SUBJECT: ExpressionNode = { kind: "reference", key: "subject" };

/**
 * Read the compiled regular-expression string back out of a pattern-builder node.
 *
 * Every builder returns the same shape — `textCompare`/`matches` over a `textLiteral` right-hand side — so anything else means trilean changed its node shape and the mismatch has to surface rather than silently degrade into a pattern that matches nothing.
 */
function compiledPattern(node: PredicateNode): string {
  if (node.kind !== "textCompare" || node.right.kind !== "textLiteral") {
    throw new TypeError(
      `Expected a textCompare node over a textLiteral, got ${node.kind}`,
    );
  }
  return node.right.value;
}

/**
 * Compile a builder node to a `RegExp`.
 *
 * No flags: trilean compiles "any character" as `[\s\S]*` rather than `.*` precisely so the string behaves the same however a consumer compiles it, with or without the `s` flag.
 */
function compiledRegex(node: PredicateNode): RegExp {
  return new RegExp(compiledPattern(node));
}

/**
 * Parse a pattern string as rule content (from `Rule.pattern`). Determines rule type from the
 * content.
 */
function parsePattern(pattern: string): ParsedPattern {
  // Domain pattern: "domain:example.com" — substring match on input
  if (pattern.startsWith("domain:")) {
    return {
      type: "wildcard",
      pattern: "*" + pattern.slice(7) + "*",
    };
  }

  // Prefix syntax: "prefix:*"
  const prefixMatch = /^(.+):\*$/.exec(pattern);
  if (prefixMatch?.[1]) {
    const prefix = unescapeContent(prefixMatch[1]);
    return { type: "prefix", prefix };
  }

  // Wildcard: has unescaped * (check raw content before unescaping)
  if (hasUnescapedWildcard(pattern)) {
    return { type: "wildcard", pattern };
  }

  // Exact: unescape for the final comparison string
  const content = unescapeContent(pattern);
  return { type: "exact", content };
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/** Match a parsed pattern against input. */
function matchPattern(parsed: ParsedPattern, input: string): boolean {
  switch (parsed.type) {
    case "bare":
      return true;
    case "exact":
      return parsed.content === input;
    case "prefix":
      return compiledRegex(prefixPattern(SUBJECT, parsed.prefix)).test(input);
    case "wildcard":
      return matchWildcard(parsed.pattern, input);
  }
}

/** Simple glob for tool name matching. Supports * (any chars) in pattern. */
function globMatch(pattern: string, text: string): boolean {
  if (pattern === text) return true;
  if (!pattern.includes("*")) return false;
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\'']/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`).test(text);
}

/**
 * Tool name matching — case-insensitive, supports MCP server-level wildcards.
 *
 * - "Bash" matches "bash"
 * - "mcp__server" matches "mcp__server__tool"
 * - "mcp__server__*" matches all tools from server
 */
function toolNamesMatch(ruleTool: string, eventTool: string): boolean {
  const r = ruleTool.toLowerCase();
  const e = eventTool.toLowerCase();

  if (r === e) return true;

  // MCP tool name matching
  if (r.startsWith("mcp__") && e.startsWith("mcp__")) {
    const rParts = r.split("__");
    const eParts = e.split("__");

    if (rParts.length === 2 && eParts.length >= 3) {
      // "mcp__server" → all tools from that server
      return rParts[1] === eParts[1];
    }
    if (rParts.length === 3 && eParts.length >= 3) {
      // "mcp__server__*" → all tools from server
      if (rParts[2] === "*") return rParts[1] === eParts[1];
      // "mcp__*__something" → wildcard server name
      if (rParts[1] === "*") {
        const rTool = rParts[2];
        const eTool = eParts[2];
        if (rTool === undefined || eTool === undefined) return false;
        return globMatch(rTool, eTool);
      }
    }
  }

  // Glob matching on bare tool names
  return globMatch(r, e);
}

/**
 * Wildcard pattern matching — Claude Code compatible.
 *
 * - Unescaped `*` matches any character sequence
 * - `\*` matches a literal asterisk
 * - `\\` matches a literal backslash
 * - Trailing ` *` (single wildcard) also matches bare command so "git *" matches both "git add file"
 *   and "git"
 *
 * The dialect above is trilean's `wildcardPattern`, which this repo's own implementation was the
 * reference for; compiling it lives there now rather than being maintained as a second copy here.
 */
function matchWildcard(pattern: string, command: string): boolean {
  return compiledRegex(wildcardPattern(SUBJECT, pattern)).test(command);
}

// ---------------------------------------------------------------------------
// Condition matching
// ---------------------------------------------------------------------------

/** Check all `when` conditions — AND logic, all must match. */
function matchConditions(when: RuleCondition, ctx: EvaluationContext): boolean {
  if (when.cwd !== undefined && ctx.cwd !== undefined) {
    if (!globMatchPath(when.cwd, ctx.cwd)) return false;
  }
  if (when.branch !== undefined && ctx.branch !== undefined) {
    if (!globMatchPath(when.branch, ctx.branch)) return false;
  }
  return true;
}

/**
 * Simple glob matching for paths/branches. `*` matches any characters, `**` matches across path separators.
 *
 * The dialect is trilean's `hierarchicalGlobPattern`, which this repo's own implementation was the reference for. The two short-circuits below are pure fast paths over the compiled regex — a pattern carrying no wildcard compiles to a fully-escaped literal, so it matches exactly the text it equals and nothing else.
 */
function globMatchPath(pattern: string, text: string): boolean {
  if (pattern === text) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return false;
  return compiledRegex(hierarchicalGlobPattern(SUBJECT, pattern)).test(text);
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

const TIERS: readonly PermissionTier[] = ["deny", "ask", "allow"];

/**
 * Evaluate a tool call against the permission policy.
 *
 * Order: deny rules → ask rules → allow rules → defaultMode
 */
export function evaluate(
  policy: PermissionPolicy,
  toolName: string,
  input: string,
  ctx: EvaluationContext = {},
): PermissionDecision {
  const { rules } = policy;
  if (rules && rules.length > 0) {
    for (const tier of TIERS) {
      for (const rule of rules) {
        if (rule.tier !== tier) continue;
        if (!toolNamesMatch(rule.tool, toolName)) continue;
        if (rule.when && !matchConditions(rule.when, ctx)) continue;
        if (rule.pattern !== undefined) {
          const parsed = parsePattern(rule.pattern);
          if (!matchPattern(parsed, input)) continue;
        }
        // No pattern = match any input; pattern matched = match
        return tier;
      }
    }
  }
  return defaultDecision(policy.defaultMode);
}

function defaultDecision(
  mode: PermissionPolicy["defaultMode"],
): PermissionDecision {
  switch (mode) {
    case "autonomous":
      return "allow";
    case "readonly":
      return "deny";
    case "restricted":
      return "ask";
    default:
      return "ask";
  }
}

// ---------------------------------------------------------------------------
// Escape helpers (Claude Code compatible)
// ---------------------------------------------------------------------------

/** Find first unescaped occurrence of `char`. */
function findFirstUnescaped(str: string, char: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === "\\") {
        bs++;
        j--;
      }
      if (bs % 2 === 0) return i;
    }
  }
  return -1;
}

/** Find last unescaped occurrence of `char`. */
function findLastUnescaped(str: string, char: string): number {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === "\\") {
        bs++;
        j--;
      }
      if (bs % 2 === 0) return i;
    }
  }
  return -1;
}

/** Check if pattern has unescaped * (not :* suffix). */
function hasUnescapedWildcard(pattern: string): boolean {
  if (pattern.endsWith(":*")) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*") {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && pattern[j] === "\\") {
        bs++;
        j--;
      }
      if (bs % 2 === 0) return true;
    }
  }
  return false;
}

/** Unescape content: ( → (, ) → ), * → *, \ → \ */
function unescapeContent(content: string): string {
  return content
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\*/g, "*")
    .replace(/\\\\/g, "\\");
}

// ---------------------------------------------------------------------------
// Structured rule → string
// ---------------------------------------------------------------------------

/**
 * Convert a structured Rule back to a string rule (e.g. `"Bash(npm:*)"`).
 *
 * Returns just the tool name for bare rules (no pattern).
 */
export function ruleToString(rule: Rule): string {
  if (rule.pattern === undefined) return rule.tool;
  return `${rule.tool}(${rule.pattern})`;
}

/**
 * Collect all rules from a canonical policy, normalising both `rules[]` and
 * `permissions.allow/deny/ask` into a single array.
 */
export function collectRules(policy: {
  rules?: Rule[] | undefined;
  permissions?:
    | {
        allow?: string[] | undefined;
        deny?: string[] | undefined;
        ask?: string[] | undefined;
      }
    | undefined;
}): Rule[] {
  const result: Rule[] = [];

  if (policy.permissions) {
    if (policy.permissions.deny) {
      result.push(
        ...policy.permissions.deny.map((r) => normaliseStringRule(r, "deny")),
      );
    }
    if (policy.permissions.ask) {
      result.push(
        ...policy.permissions.ask.map((r) => normaliseStringRule(r, "ask")),
      );
    }
    if (policy.permissions.allow) {
      result.push(
        ...policy.permissions.allow.map((r) => normaliseStringRule(r, "allow")),
      );
    }
  }

  if (policy.rules) {
    result.push(...policy.rules);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Shared merge utilities
// ---------------------------------------------------------------------------

/** Most restrictive mode wins. */
const MODE_RESTRICTIVENESS: Record<string, number> = {
  readonly: 4,
  restricted: 3,
  plan: 3,
  standard: 2,
  acceptEdits: 2,
  default: 2,
  auto: 2,
  autonomous: 1,
  dontAsk: 1,
  bypassPermissions: 1,
};

/** Tier priority for deduplication — deny beats ask beats allow. */
const TIER_RANK: Record<PermissionTier, number> = {
  deny: 3,
  ask: 2,
  allow: 1,
};

/**
 * Map a schema-mode string to a normalised evaluation mode.
 *
 * Agent-specific names (bypassPermissions, dontAsk, plan) are mapped to their canonical
 * equivalents.
 */
export function mapMode(mode: string): PermissionPolicy["defaultMode"] {
  switch (mode) {
    case "autonomous":
    case "bypassPermissions":
    case "dontAsk":
      return "autonomous";
    case "restricted":
    case "plan":
      return "restricted";
    case "readonly":
      return "readonly";
    default:
      return "standard";
  }
}

/** Compare two mode strings by restrictiveness. Returns the more restrictive of the two. */
export function mostRestrictiveMode(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const rankA = MODE_RESTRICTIVENESS[a] ?? 2;
  const rankB = MODE_RESTRICTIVENESS[b] ?? 2;
  return rankB > rankA ? b : a;
}

/** Rule identity key for deduplication (tool + pattern, excluding tier). */
export function ruleKey(rule: Rule): string {
  return `${rule.tool}:${rule.pattern ?? ""}`;
}

/**
 * Deduplicate rules by tool+pattern, keeping the highest-priority tier. Deny beats ask beats allow
 * for the same tool+pattern combination.
 */
export function deduplicateRules(rules: Rule[]): Rule[] {
  const map = new Map<string, Rule>();
  for (const rule of rules) {
    const key = ruleKey(rule);
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, rule);
    } else if (TIER_RANK[rule.tier] > TIER_RANK[existing.tier]) {
      map.set(key, rule);
    }
  }
  return Array.from(map.values());
}
