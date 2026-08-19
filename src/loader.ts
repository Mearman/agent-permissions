/**
 * Permission policy loader — walk-up discovery and merge.
 *
 * Walks up from `cwd`, collecting canonical and native agent config files. Merge semantics:
 *
 * - With/without: unioned from all discovered canonical files
 * - Up: outermost canonical file wins (team controls walk-up depth)
 * - DefaultMode: last-defined wins (innermost/cwd overrides)
 * - Rules: collected from all sources, deduplicated deny-first
 *
 * Load order at each directory (innermost processed last):
 *
 * 1. `.agents/permissions.json` (team, committed)
 * 2. `.agents/permissions.local.json` (personal, gitignored)
 * 3. Native agent configs filtered by with/without
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

import { type AgentPermissionPolicy, type Rule } from "./schema.ts";
import {
  AGENT_FILES,
  defaultFilePath,
  parseAgentFile,
  validatePolicy,
  decodeNative,
} from "./agent-files.ts";
import {
  collectRules,
  mapMode,
  deduplicateRules,
  type PermissionPolicy,
} from "./evaluate.ts";
import { type AgentId, CODECS } from "./compat/codecs.ts";
import { isAgentId } from "./guards.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolicyLoadOptions {
  /** Starting directory for walk-up discovery. */
  cwd: string;
}

interface DiscoveredFile {
  /** Agent identifier (e.g. "canonical", "claude-code"). */
  agent: AgentId | "canonical";
  /** Absolute path to the config file. */
  path: string;
  /** Whether this is a local override (read-only in merge). */
  local: boolean;
}

interface DecodedLayer {
  file: DiscoveredFile;
  policy: AgentPermissionPolicy;
}

// ---------------------------------------------------------------------------
// Walk-up discovery
// ---------------------------------------------------------------------------

/**
 * Resolve effective `up` and agent filter from all discovered canonical files.
 *
 * - `up`: outermost canonical file's value wins (team controls depth). Falls back to `"all"` if no
 *   canonical file specifies it.
 * - `with`/`without`: unioned across all canonical files.
 */
function resolveDiscoveryConfig(canonicalLayers: DecodedLayer[]): {
  up: number;
  agentFilter: Set<string> | undefined;
  globalAgents: Set<AgentId>;
} {
  let up = Infinity;
  // Set<string>, not Set<AgentId>: the filters compare against Object.keys() output (plain strings) and carry "canonical" alongside agent ids.
  const withAgents = new Set<string>();
  const withoutAgents = new Set<string>();

  // canonicalLayers are outermost-first after reverse.
  for (const layer of canonicalLayers) {
    const { with: w, without: wo, up: u } = layer.policy;
    if (u !== undefined) {
      const resolved = u === "all" ? Infinity : u;
      // Outermost wins — take the first up value we see (outermost-first)
      if (up === Infinity) {
        up = resolved;
      }
    }
    if (w !== undefined) {
      for (const a of w) withAgents.add(a);
    }
    if (wo !== undefined) {
      for (const a of wo) withoutAgents.add(a);
    }
  }

  // Build agent filter
  let agentFilter: Set<string> | undefined;
  if (withAgents.size > 0 && withoutAgents.size > 0) {
    // Invalid — a single file can't have both, and cross-file we
    // treat the combination as: with takes precedence (most restrictive)
    const allAgents = [...Object.keys(CODECS), "canonical"];
    agentFilter = new Set([...withAgents, "canonical"]);
    // Also include any agent NOT in withoutAgents
    for (const a of allAgents) {
      if (!withoutAgents.has(a)) {
        agentFilter.add(a);
      }
    }
  } else if (withAgents.size > 0) {
    agentFilter = new Set([...withAgents, "canonical"]);
  } else if (withoutAgents.size > 0) {
    const allAgents = [...Object.keys(CODECS), "canonical"];
    const excluded = new Set(withoutAgents);
    agentFilter = new Set(allAgents.filter((a) => !excluded.has(a)));
  }

  // No with/without = canonical only (safe default)
  // withAgents and withoutAgents are both empty, agentFilter stays undefined
  // but discoverFiles still needs to know not to read native configs.
  // We achieve this by passing a filter that only includes "canonical".
  if (withAgents.size === 0 && withoutAgents.size === 0) {
    agentFilter = new Set(["canonical"]);
  }

  return { up, agentFilter, globalAgents: withAgents };
}

/**
 * Walk up from cwd, collecting agent config files. Returns files ordered outermost-first (outermost
 * layers first, innermost/cwd layers last) so that last-defined-wins merge gives cwd the highest
 * priority.
 *
 * Within each directory, committed files come before local files, so local overrides committed at
 * the same level.
 */
function discoverFiles(
  cwd: string,
  up: number,
  agentFilter: Set<string> | undefined,
  globalAgents: Set<AgentId>,
): DiscoveredFile[] {
  const dirBuckets: DiscoveredFile[][] = [];
  const globalFiles: DiscoveredFile[] = [];
  let current = resolve(cwd);
  let remaining = up === Infinity ? Number.MAX_SAFE_INTEGER : up + 1;

  while (remaining > 0) {
    const bucket: DiscoveredFile[] = [];
    for (const [key, def] of Object.entries(AGENT_FILES)) {
      if (!isAgentId(key) && key !== "canonical") continue;
      const agent: AgentId | "canonical" = key;
      // Apply agent filter
      if (agentFilter && !agentFilter.has(agent)) continue;
      if (agent !== "canonical" && def.extract === undefined) continue;
      if (def.global) continue;

      const main = join(current, def.name);
      if (existsSync(main)) {
        bucket.push({ agent, path: main, local: false });
      }

      if (def.localName) {
        const local = join(current, def.localName);
        if (existsSync(local)) {
          bucket.push({ agent, path: local, local: true });
        }
      }
    }
    dirBuckets.push(bucket);

    remaining--;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const [key, def] of Object.entries(AGENT_FILES)) {
    if (!isAgentId(key)) continue;
    const agent: AgentId = key;
    if (
      !def.global ||
      !globalAgents.has(agent) ||
      (agentFilter && !agentFilter.has(agent)) ||
      def.extract === undefined
    ) {
      continue;
    }
    const path = defaultFilePath(agent, cwd);
    if (existsSync(path)) globalFiles.push({ agent, path, local: false });
  }

  dirBuckets.reverse();
  return [...dirBuckets.flat(), ...globalFiles];
}

// ---------------------------------------------------------------------------
// Reading and decoding
// ---------------------------------------------------------------------------

async function readFileContent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

function decodeFile(
  file: DiscoveredFile,
  raw: unknown,
): AgentPermissionPolicy | undefined {
  if (file.agent === "canonical") {
    const result = validatePolicy(raw);
    return result.ok ? result.value : undefined;
  }

  const result = decodeNative(file.agent, raw);
  return result.ok ? result.value : undefined;
}

async function readAndDecode(
  file: DiscoveredFile,
): Promise<DecodedLayer | undefined> {
  const content = await readFileContent(file.path);
  if (content === undefined) return undefined;

  const parsed = parseAgentFile(file.agent, content, file.path);
  if (!parsed.ok) return undefined;

  const policy = decodeFile(file, parsed.value);
  if (policy === undefined) return undefined;

  return { file, policy };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

function mergeLayers(layers: DecodedLayer[]): PermissionPolicy {
  if (layers.length === 0) {
    return { defaultMode: "standard" };
  }

  let mode: PermissionPolicy["defaultMode"] = "standard";
  const allRules: Rule[] = [];

  // Layers are outermost-first. Last-defined wins for defaultMode.
  for (const layer of layers) {
    if (layer.policy.defaultMode) {
      mode = mapMode(layer.policy.defaultMode);
    }
    allRules.push(...collectRules(layer.policy));
  }

  const rules = deduplicateRules(allRules);

  return {
    defaultMode: mode,
    ...(rules.length > 0 ? { rules } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and merge permission policy from all sources.
 *
 * Two-pass process:
 *
 * 1. Discover canonical files, resolve `up`/`with`/`without` from them.
 * 2. Re-discover all files (canonical + native) using resolved config, decode, and merge.
 */
export async function loadPolicy(
  options: PolicyLoadOptions,
): Promise<PermissionPolicy> {
  const { cwd } = options;

  // Pass 1: discover canonical files with max walk-up to find all of them
  const canonicalFiles = discoverFiles(
    cwd,
    Infinity,
    new Set(["canonical"]),
    new Set(),
  );
  const canonicalLayers: DecodedLayer[] = [];
  for (const file of canonicalFiles) {
    const layer = await readAndDecode(file);
    if (layer) canonicalLayers.push(layer);
  }

  if (canonicalLayers.length === 0) {
    return { defaultMode: "standard" };
  }

  // Resolve discovery config from canonical files
  const { up, agentFilter, globalAgents } =
    resolveDiscoveryConfig(canonicalLayers);

  const allFiles = discoverFiles(cwd, up, agentFilter, globalAgents);

  const allLayers: DecodedLayer[] = [];
  for (const file of allFiles) {
    const layer = await readAndDecode(file);
    if (layer) allLayers.push(layer);
  }

  return mergeLayers(allLayers);
}
