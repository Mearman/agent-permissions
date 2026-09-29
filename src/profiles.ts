/**
 * Profile inheritance: a profile may `extends` other profiles and then state only what differs.
 *
 * Extending only adds. A profile's deny, ask and allow lists are its parents' lists followed by its own, so a child cannot remove
 * a restriction a parent set. The default mode is the profile's own, else the last parent's that sets one.
 */

import type { PermissionTiers, Profiles } from "./schema.ts";

/** Where a profile's `extends` does not lead to a usable parent. */
export interface ProfileProblem {
  /** The profile whose `extends` is wrong. */
  profile: string;
  message: string;
}

/** Every profile whose `extends` names a profile that does not exist, or that loops back on itself. */
export function profileProblems(
  profiles: Profiles | undefined,
): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  const all = profiles ?? {};
  for (const [name, profile] of Object.entries(all)) {
    for (const parent of profile.extends ?? []) {
      if (!(parent in all)) {
        problems.push({
          profile: name,
          message: `profile "${name}" extends "${parent}", which does not exist`,
        });
      }
    }
  }
  if (problems.length > 0) return problems;

  for (const name of Object.keys(all)) {
    const cycle = findCycle(all, name, []);
    if (cycle !== undefined) {
      problems.push({
        profile: name,
        message: `profiles extend each other in a cycle: ${cycle.join(" -> ")}`,
      });
      break;
    }
  }
  return problems;
}

/** The chain that leads from `name` back to a profile already on the path, or `undefined`. */
function findCycle(
  profiles: Profiles,
  name: string,
  path: readonly string[],
): string[] | undefined {
  if (path.includes(name)) return [...path.slice(path.indexOf(name)), name];
  for (const parent of profiles[name]?.extends ?? []) {
    const cycle = findCycle(profiles, parent, [...path, name]);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

/**
 * Flatten `extends`: every profile with its parents' rules ahead of its own and no `extends` left.
 *
 * @throws Error if a profile extends one that does not exist or the profiles extend each other in a cycle.
 */
export function resolveProfiles(
  profiles: Profiles | undefined,
): Record<string, PermissionTiers> {
  const all = profiles ?? {};
  const problem = profileProblems(all)[0];
  if (problem !== undefined) throw new Error(problem.message);

  const resolved: Record<string, PermissionTiers> = {};
  const resolve = (name: string): PermissionTiers => {
    const cached = resolved[name];
    if (cached !== undefined) return cached;
    const { extends: parents = [], ...own } = all[name] ?? {};
    const result: PermissionTiers = {};
    for (const source of [...parents.map(resolve), own]) {
      for (const list of [
        "deny",
        "ask",
        "allow",
        "additionalDirectories",
      ] as const) {
        const merged = [...(result[list] ?? []), ...(source[list] ?? [])];
        if (merged.length > 0) result[list] = [...new Set(merged)];
      }
      if (source.defaultMode !== undefined)
        result.defaultMode = source.defaultMode;
    }
    resolved[name] = result;
    return result;
  };
  for (const name of Object.keys(all)) resolve(name);
  return resolved;
}
