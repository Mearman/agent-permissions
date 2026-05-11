/**
 * Permission policy loader — reads and merges permission files.
 *
 * Load order (later sources override earlier):
 *   1. `.agents/permissions.json` (team, committed)
 *   2. `.agents/permissions.local.json` (personal, gitignored)
 *   3. Native agent configs (if enabled via config)
 *
 * Merge rules:
 *   - defaultMode: last-defined wins
 *   - rules: collected from all sources, deduplicated with deny-first priority
 *     (deny > ask > allow for same tool+pattern)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentPermissionPolicy, type Rule } from "./schema.ts";
import {
  AGENT_FILES,
  parseJson,
  validatePolicy,
  decodeNative,
} from "./agent-files.ts";

import {
  collectRules,
  mapMode,
  deduplicateRules,
  type PermissionPolicy,
} from "./evaluate.ts";

export interface PolicyLoadOptions {
  cwd: string;
  /** Read native agent configs and convert to canonical form. */
  nativeSources?: ("claude-code" | "codex" | "opencode")[] | undefined;
}

/**
 * Load and merge permission policy from all sources.
 */
export async function loadPolicy(
  options: PolicyLoadOptions,
): Promise<PermissionPolicy> {
  const { cwd, nativeSources = [] } = options;
  const layers: AgentPermissionPolicy[] = [];

  // Layer 1: .agents/permissions.json
  const committed = await loadCanonical(
    join(cwd, ".agents", "permissions.json"),
  );
  if (committed) layers.push(committed);

  // Layer 2: .agents/permissions.local.json
  const local = await loadCanonical(
    join(cwd, ".agents", "permissions.local.json"),
  );
  if (local) layers.push(local);

  // Layer 3: native configs
  for (const source of nativeSources) {
    const native = await loadNative(cwd, source);
    if (native) layers.push(native);
  }

  return mergeLayers(layers);
}

async function loadCanonical(
  filePath: string,
): Promise<AgentPermissionPolicy | undefined> {
  const content = await readJsonFile(filePath);
  if (content === undefined) return undefined;
  const parsed = parseJson(content, filePath);
  if (!parsed.ok) return undefined;
  const validated = validatePolicy(parsed.value);
  if (!validated.ok) return undefined;
  return validated.value;
}

async function loadNative(
  cwd: string,
  source: "claude-code" | "codex" | "opencode",
): Promise<AgentPermissionPolicy | undefined> {
  // Codex uses TOML — consumer should pre-parse and pass the object.
  if (source === "codex") return undefined;

  // Only claude-code and opencode are supported (codex handled above)
  if (!(source in AGENT_FILES)) return undefined;
  const def = AGENT_FILES[source];
  if (def.extract === undefined) return undefined;

  const filePath = join(cwd, def.name);
  const content = await readJsonFile(filePath);
  if (content === undefined) return undefined;
  const parsed = parseJson(content, filePath);
  if (!parsed.ok) return undefined;

  const result = decodeNative(source, parsed.value);
  if (!result.ok) return undefined;
  return result.value;
}

async function readJsonFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

function mergeLayers(layers: AgentPermissionPolicy[]): PermissionPolicy {
  if (layers.length === 0) {
    return { defaultMode: "standard" };
  }

  let mode: PermissionPolicy["defaultMode"] = "standard";
  const allRules: Rule[] = [];

  for (const layer of layers) {
    if (layer.defaultMode) {
      mode = mapMode(layer.defaultMode);
    }
    allRules.push(...collectRules(layer));
  }

  const rules = deduplicateRules(allRules);

  return {
    defaultMode: mode,
    ...(rules.length > 0 ? { rules } : {}),
  };
}
