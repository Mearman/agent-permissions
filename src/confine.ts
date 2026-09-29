/**
 * Confinement policy generation: rules that keep an agent's file tools inside a set of directories.
 *
 * Deny-first evaluation means "deny everything except these directories" cannot be written as a blanket deny plus allows, because the deny would beat the allows. No pattern dialect can negate either: patterns are exact, `prefix:*` or `*` wildcards. The generated policy therefore does three things the evaluator can express:
 *
 * 1. Allow the file tools on each root and on everything below it.
 * 2. Deny any path containing a `..` segment, because a wildcard allow such as `/work/app/*` matches the text `/work/app/../secret` even though that path leaves the root.
 * 3. Set `defaultMode` so that a file tool call matching no allow rule asks (or is denied). That mode is global: it applies to every tool without a rule of its own, not only the file tools.
 *
 * This is a convenience, not a sandbox. Only the file tools are constrained; a `Bash` command can still read or write anywhere. Use the `sandbox` field for enforcement.
 */

import { resolve } from "node:path";

import type { AgentPermissionPolicy, Rule } from "./schema.ts";

/** The tools whose path argument is confined. */
const FILE_TOOLS = ["Read", "Edit", "Write"] as const;

/** What happens to a file tool call outside the roots: `ask` prompts (default mode `restricted`), `deny` refuses (default mode `readonly`). */
export type OutsideBehaviour = "ask" | "deny";

/** Inputs to {@link confine}. */
export interface ConfineOptions {
  /** Directories the file tools may reach. Relative entries resolve against `cwd`. */
  roots: readonly string[];
  /** The agent's working directory, which needs no `additionalDirectories` entry. */
  cwd: string;
  /** Behaviour outside the roots. Defaults to `ask`. */
  outside?: OutsideBehaviour;
}

/** Escape a literal path for use inside a wildcard pattern, where `*` matches any run of characters and a backslash escapes. */
function escapePath(path: string): string {
  return path.replace(/[\\*]/g, "\\$&");
}

/**
 * Generate a canonical policy that confines `Read`, `Edit` and `Write` to `options.roots`.
 *
 * Paths are normalised with `path.resolve` against `cwd`: made absolute, `.` and `..` segments collapsed, trailing separators removed, duplicates dropped. Tool inputs are matched as literal text, so a call whose path is relative or contains `..` is never allowed by the root rules.
 *
 * @throws Error if `roots` is empty.
 */
export function confine(options: ConfineOptions): AgentPermissionPolicy {
  const { cwd, outside = "ask" } = options;
  const roots = [...new Set(options.roots.map((root) => resolve(cwd, root)))];
  if (roots.length === 0) throw new Error("at least one root is required");

  const rules: Rule[] = [];

  // The root itself is matched exactly; the wildcard requires the separator, so a sibling that shares the root as a string prefix (`/work/app-secrets`) does not match.
  for (const root of roots) {
    const below = root.endsWith("/") ? root : `${root}/`;
    for (const tool of FILE_TOOLS) {
      rules.push({ tool, pattern: escapePath(root), tier: "allow" });
      rules.push({ tool, pattern: `${escapePath(below)}*`, tier: "allow" });
    }
  }

  for (const tool of FILE_TOOLS) {
    for (const pattern of ["..", "../*", "*/..", "*/../*"]) {
      rules.push({ tool, pattern, tier: "deny" });
    }
  }

  const policy: AgentPermissionPolicy = {
    defaultMode: outside === "deny" ? "readonly" : "restricted",
    rules,
  };
  const additionalDirectories = roots.filter((root) => root !== resolve(cwd));
  if (additionalDirectories.length > 0) {
    policy.permissions = { additionalDirectories };
  }
  return policy;
}
