/**
 * Permission evaluator — deny-first rule matching.
 *
 * Evaluation order:
 *   1. deny rules — if any match, return "deny"
 *   2. ask rules — if any match, return "ask"
 *   3. allow rules — if any match, return "allow"
 *   4. defaultMode — fallback behaviour
 */

import type { PermissionTiers } from "./schema.ts";

export type PermissionDecision = "deny" | "ask" | "allow";

export interface PermissionPolicy {
  defaultMode: "autonomous" | "standard" | "restricted" | "readonly";
  permissions?: PermissionTiers;
}

/**
 * Evaluate a tool call against the permission policy.
 */
export function evaluate(
  policy: PermissionPolicy,
  toolName: string,
  input: string,
): PermissionDecision {
  const { permissions } = policy;
  if (!permissions) {
    return defaultDecision(policy.defaultMode);
  }

  // Deny-first: if any deny rule matches, deny immediately
  if (permissions.deny) {
    for (const rule of permissions.deny) {
      if (matchesRule(rule, toolName, input)) {
        return "deny";
      }
    }
  }

  // Ask rules
  if (permissions.ask) {
    for (const rule of permissions.ask) {
      if (matchesRule(rule, toolName, input)) {
        return "ask";
      }
    }
  }

  // Allow rules
  if (permissions.allow) {
    for (const rule of permissions.allow) {
      if (matchesRule(rule, toolName, input)) {
        return "allow";
      }
    }
  }

  return defaultDecision(policy.defaultMode);
}

/**
 * Check if a rule matches a tool call.
 *
 * Rule patterns:
 *   - "ToolName" — exact tool name, any input
 *   - "ToolName(pattern)" — tool name with pattern matching against input
 *   - "ToolName(domain:example.com)" — domain-specific matching
 *   - "mcp__server__*" — MCP tool prefix matching
 */
function matchesRule(rule: string, toolName: string, input: string): boolean {
  // Extract tool name and optional pattern from the rule
  const parenIndex = rule.indexOf("(");
  if (parenIndex === -1) {
    // Bare tool name — case-insensitive, could be a glob pattern
    return globMatch(rule.toLowerCase(), toolName.toLowerCase());
  }

  const ruleTool = rule.slice(0, parenIndex);
  const rulePattern = rule.slice(parenIndex + 1, -1); // strip parens

  // Tool name must match (case-insensitive)
  if (!globMatch(ruleTool.toLowerCase(), toolName.toLowerCase())) {
    return false;
  }

  // Empty pattern means match any input
  if (rulePattern.length === 0) {
    return true;
  }

  // Domain pattern: "domain:example.com"
  if (rulePattern.startsWith("domain:")) {
    const domain = rulePattern.slice(7);
    return input.includes(domain);
  }

  // Prefix pattern: "git:*", "npm run *"
  if (rulePattern.endsWith(":*")) {
    const prefix = rulePattern.slice(0, -2);
    return input.startsWith(prefix);
  }

  // Wildcard/glob pattern
  return globMatch(rulePattern, input);
}

/**
 * Simple glob matching against a pattern.
 * Supports * (any characters) and ? (single character).
 */
function globMatch(pattern: string, text: string): boolean {
  // Exact match
  if (pattern === text) return true;

  // No wildcards — not a match unless exact
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return false;
  }

  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(text);
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
