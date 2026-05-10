/**
 * Permission evaluator — deny-first rule matching.
 *
 * Faithfully implements Claude Code's rule syntax:
 *   - Exact: `Tool(command)` — string equality
 *   - Prefix: `Tool(prefix:*)` — word-boundary enforced prefix match
 *   - Wildcard: `Tool(pattern * middle *)` — regex with `.*` for `*`
 *   - Bare: `Tool` — matches any invocation of that tool
 *
 * Plus our extensions:
 *   - Conditional rules (`rules[]`) with `when.cwd` / `when.branch`
 *   - Case-insensitive tool name matching
 *   - `domain:` pattern for WebFetch tools
 *
 * Evaluation order:
 *   1. `rules[]` — first matching conditional rule wins (deny/ask/allow)
 *   2. deny tier — if any deny rule matches, return "deny"
 *   3. ask tier — if any ask rule matches, return "ask"
 *   4. allow tier — if any allow rule matches, return "allow"
 *   5. defaultMode — fallback behaviour
 */

import type {
  PermissionTiers,
  ConditionalRule,
  RuleCondition,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PermissionDecision = "deny" | "ask" | "allow";

export interface PermissionPolicy {
  defaultMode: "autonomous" | "standard" | "restricted" | "readonly";
  permissions?: PermissionTiers;
  rules?: ConditionalRule[];
}

/** Context for conditional rule evaluation (cwd, branch, etc.). */
export interface EvaluationContext {
  cwd?: string;
  branch?: string;
}

// ---------------------------------------------------------------------------
// Rule parsing
// ---------------------------------------------------------------------------

/**
 * Parsed rule discriminated union — mirrors Claude Code's ShellPermissionRule.
 */
type ParsedRule =
  | { type: "bare"; toolName: string }
  | { type: "exact"; toolName: string; content: string }
  | { type: "prefix"; toolName: string; prefix: string }
  | { type: "wildcard"; toolName: string; pattern: string };

// Null-byte sentinels for safe wildcard escaping (compiled once).
const ESCAPED_STAR = "\x00STAR\x00";
const ESCAPED_BACKSLASH = "\x00BACKSLASH\x00";
const ESCAPED_STAR_RE = new RegExp(ESCAPED_STAR, "g");
const ESCAPED_BACKSLASH_RE = new RegExp(ESCAPED_BACKSLASH, "g");

/**
 * Parse a rule string into a structured rule.
 *
 * Format: "ToolName" or "ToolName(content)"
 * Content may contain escaped parentheses: \( and \)
 *
 * Rule types:
 *   - Bare: "Tool" or "Tool()" or "Tool(*)"
 *   - Prefix: content ends with ":*" (e.g. "Bash(npm:*)")
 *   - Wildcard: content has unescaped * but not :* suffix
 *   - Exact: no wildcards
 */
function parseRule(rule: string): ParsedRule {
  const openIdx = findFirstUnescaped(rule, "(");
  if (openIdx === -1) {
    return { type: "bare", toolName: rule };
  }

  const closeIdx = findLastUnescaped(rule, ")");
  if (closeIdx === -1 || closeIdx <= openIdx || closeIdx !== rule.length - 1) {
    return { type: "bare", toolName: rule };
  }

  const toolName = rule.slice(0, openIdx);
  if (!toolName) {
    return { type: "bare", toolName: rule };
  }

  const rawContent = rule.slice(openIdx + 1, closeIdx);
  if (rawContent === "" || rawContent === "*") {
    return { type: "bare", toolName };
  }

  const content = unescapeContent(rawContent);

  // Domain pattern: "domain:example.com" — substring match on input
  if (content.startsWith("domain:")) {
    return {
      type: "wildcard",
      toolName,
      pattern: "*" + content.slice(7) + "*",
    };
  }

  // Prefix syntax: "prefix:*"
  const prefixMatch = /^(.+):\*$/.exec(content);
  if (prefixMatch?.[1]) {
    return { type: "prefix", toolName, prefix: prefixMatch[1] };
  }

  // Wildcard: has unescaped *
  if (hasUnescapedWildcard(content)) {
    return { type: "wildcard", toolName, pattern: content };
  }

  return { type: "exact", toolName, content };
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

/**
 * Match a parsed rule's pattern against input only (tool name already verified).
 */
function matchPattern(rule: ParsedRule, input: string): boolean {
  switch (rule.type) {
    case "bare":
      return true;
    case "exact":
      return rule.content === input;
    case "prefix":
      return input === rule.prefix || input.startsWith(rule.prefix + " ");
    case "wildcard":
      return matchWildcard(rule.pattern, input);
  }
}

function matchRule(rule: ParsedRule, toolName: string, input: string): boolean {
  if (!toolNamesMatch(rule.toolName, toolName)) return false;
  return matchPattern(rule, input);
}

/**
 * Simple glob for tool name matching.
 * Supports * (any chars) in pattern.
 */
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
 * - Trailing ` *` (single wildcard) also matches bare command
 *   so "git *" matches both "git add file" and "git"
 */
function matchWildcard(pattern: string, command: string): boolean {
  const trimmed = pattern.trim();

  // Phase 1: Process escape sequences into sentinels
  let processed = "";
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
      const next = trimmed[i + 1];
      if (next === "*") {
        processed += ESCAPED_STAR;
        i += 2;
        continue;
      }
      if (next === "\\") {
        processed += ESCAPED_BACKSLASH;
        i += 2;
        continue;
      }
    }
    const char = trimmed.charAt(i);
    processed += char;
    i++;
  }

  // Phase 2: Escape regex special chars (except *)
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, "\\$&");

  // Phase 3: Unescaped * → .*
  let regexStr = escaped.replace(/\*/g, ".*");

  // Phase 4: Restore sentinels as escaped literals
  regexStr = regexStr
    .replace(ESCAPED_STAR_RE, "\\*")
    .replace(ESCAPED_BACKSLASH_RE, "\\\\");

  // Phase 5: Trailing " *" (single wildcard) → match bare command too
  const unescapedStarCount = (processed.match(/\*/g) ?? []).length;
  if (regexStr.endsWith(" .*") && unescapedStarCount === 1) {
    regexStr = regexStr.slice(0, -3) + "( .*)?";
  }

  const regex = new RegExp(`^${regexStr}$`, "s");
  return regex.test(command);
}

// ---------------------------------------------------------------------------
// Conditional rule evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate conditional rules. First matching rule wins.
 * Falls through to return undefined if no rule matches.
 */
function evaluateConditionalRules(
  rules: ConditionalRule[],
  toolName: string,
  input: string,
  ctx: EvaluationContext,
): PermissionDecision | undefined {
  for (const rule of rules) {
    // Check tool name first (cheapest check)
    if (!toolNamesMatch(rule.tool, toolName)) continue;

    // Check conditions before pattern (conditions are cheaper)
    if (rule.when && !matchConditions(rule.when, ctx)) continue;

    // Parse and match the pattern (tool name already verified above)
    const parsed = parseRuleWithContent(rule.pattern);
    if (matchPattern(parsed, input)) {
      return rule.tier;
    }
  }
  return undefined;
}

/**
 * Parse a pattern string (from conditionalRule.pattern) as if it were
 * the content inside Tool(...). Determines rule type from the content.
 */
function parseRuleWithContent(pattern: string): ParsedRule {
  // Prefix syntax
  const prefixMatch = /^(.+):\*$/.exec(pattern);
  if (prefixMatch?.[1]) {
    return { type: "prefix", toolName: "", prefix: prefixMatch[1] };
  }

  // Wildcard
  if (hasUnescapedWildcard(pattern)) {
    return { type: "wildcard", toolName: "", pattern };
  }

  // Exact
  return { type: "exact", toolName: "", content: pattern };
}

/**
 * Check all `when` conditions — AND logic, all must match.
 */
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
 * Simple glob matching for paths/branches.
 * `*` matches any characters, `**` matches across path separators.
 */
function globMatchPath(pattern: string, text: string): boolean {
  if (pattern === text) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return false;

  // Normalise ** → matches anything including /
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\'"]/g, "\\$&")
    .replace(/\*\*/g, "⟪DOUBLESTAR⟫")
    .replace(/\*/g, "[^/]*")
    .replace(/⟪DOUBLESTAR⟫/g, ".*")
    .replace(/\?/g, "[^/]");

  return new RegExp(`^${regexStr}$`).test(text);
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate a tool call against the permission policy.
 *
 * Order: conditional rules → deny → ask → allow → defaultMode
 */
export function evaluate(
  policy: PermissionPolicy,
  toolName: string,
  input: string,
  ctx: EvaluationContext = {},
): PermissionDecision {
  // 1. Conditional rules — first match wins
  if (policy.rules && policy.rules.length > 0) {
    const decision = evaluateConditionalRules(
      policy.rules,
      toolName,
      input,
      ctx,
    );
    if (decision !== undefined) return decision;
  }

  const { permissions } = policy;
  if (!permissions) {
    return defaultDecision(policy.defaultMode);
  }

  // 2. Deny tier — deny from any source short-circuits everything
  if (permissions.deny) {
    for (const ruleStr of permissions.deny) {
      const rule = parseRule(ruleStr);
      if (matchRule(rule, toolName, input)) {
        return "deny";
      }
    }
  }

  // 3. Ask tier
  if (permissions.ask) {
    for (const ruleStr of permissions.ask) {
      const rule = parseRule(ruleStr);
      if (matchRule(rule, toolName, input)) {
        return "ask";
      }
    }
  }

  // 4. Allow tier
  if (permissions.allow) {
    for (const ruleStr of permissions.allow) {
      const rule = parseRule(ruleStr);
      if (matchRule(rule, toolName, input)) {
        return "allow";
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

/** Unescape content: \( → (, \) → ), \\ → \ */
function unescapeContent(content: string): string {
  return content
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}
