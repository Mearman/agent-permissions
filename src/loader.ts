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
import { existsSync, watch, type FSWatcher } from "node:fs";

import { type AgentPermissionPolicy, type Rule } from "./schema.ts";
import {
  AGENT_FILES,
  parseJson,
  validatePolicy,
  decodeNative,
} from "./agent-files.ts";
import {
  collectRules,
  delegationLimits,
  mapMode,
  mostRestrictiveMode,
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

  return { up, agentFilter };
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
): DiscoveredFile[] {
  // Collect per-directory buckets, cwd-first
  const dirBuckets: DiscoveredFile[][] = [];
  let current = resolve(cwd);
  let remaining = up === Infinity ? Number.MAX_SAFE_INTEGER : up + 1;

  while (remaining > 0) {
    const bucket: DiscoveredFile[] = [];
    for (const [key, def] of Object.entries(AGENT_FILES)) {
      if (!isAgentId(key) && key !== "canonical") continue;
      const agent: AgentId | "canonical" = key;
      // Apply agent filter
      if (agentFilter && !agentFilter.has(agent)) continue;

      // Skip agents without extract (codex TOML, crush no file)
      if (agent !== "canonical" && def.extract === undefined) continue;

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
    if (parent === current) break; // reached root
    current = parent;
  }

  // Reverse directory order so outermost is first.
  // Within each directory, committed comes before local.
  dirBuckets.reverse();
  return dirBuckets.flat();
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

/** What reading one discovered file gave: its layer, nothing because it is gone, or why it failed. */
type ReadResult =
  { layer: DecodedLayer } | { absent: true } | { failure: string };

async function readLayer(file: DiscoveredFile): Promise<ReadResult> {
  const content = await readFileContent(file.path);
  if (content === undefined) {
    // A file deleted since discovery is a change, not a failure.
    return existsSync(file.path)
      ? { failure: `${file.path} could not be read` }
      : { absent: true };
  }

  const parsed = parseJson(content, file.path);
  if (!parsed.ok) return { failure: `${file.path}: ${parsed.error}` };

  const policy = decodeFile(file, parsed.value);
  if (policy === undefined) {
    return { failure: `${file.path} is not a valid ${file.agent} policy` };
  }

  return { layer: { file, policy } };
}

/** The layers found from `cwd`, and the files that were there but could not be used. */
async function loadLayers(
  cwd: string,
): Promise<{ layers: DecodedLayer[]; failures: string[] }> {
  const failures = new Set<string>();
  const read = async (files: DiscoveredFile[]): Promise<DecodedLayer[]> => {
    const layers: DecodedLayer[] = [];
    for (const file of files) {
      const result = await readLayer(file);
      if ("layer" in result) layers.push(result.layer);
      else if ("failure" in result) failures.add(result.failure);
    }
    return layers;
  };

  // Pass 1: discover canonical files with max walk-up to find all of them
  const canonicalLayers = await read(
    discoverFiles(cwd, Infinity, new Set(["canonical"])),
  );
  if (canonicalLayers.length === 0) {
    return { layers: [], failures: [...failures] };
  }

  // Resolve discovery config from canonical files
  const { up, agentFilter } = resolveDiscoveryConfig(canonicalLayers);

  // Pass 2: discover all files using resolved config
  const layers = await read(discoverFiles(cwd, up, agentFilter));
  return { layers, failures: [...failures] };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/** One source of policy: a name for provenance, its policy, and whether it bounds deeper layers. */
export interface PolicyLayer {
  /** What the layer came from, usually a file path; it is what `explain` reports for its rules. */
  source: string;
  policy: AgentPermissionPolicy;
  /** The layer's allow rules bound what the layers after it can allow. */
  ceiling?: boolean;
}

/**
 * Merge layers, outermost first, into one policy.
 *
 * - Rules from every layer are collected and deduplicated deny-first; each rule remembers its layer.
 * - The default mode is the innermost layer's, except after a ceiling layer, where a deeper layer can
 *   only make it stricter.
 * - Delegation limits tighten: the shallowest `maxDepth`, every `nonDelegable` rule.
 * - A ceiling layer that allows something bounds the allow rules of the layers after it (see
 *   {@link PermissionPolicy.layers}).
 */
export function mergeLayerPolicies(
  layers: readonly PolicyLayer[],
): PermissionPolicy {
  if (layers.length === 0) {
    return { defaultMode: "standard" };
  }

  let mode: PermissionPolicy["defaultMode"] = "standard";
  let ceilingAbove = false;
  const allRules: Rule[] = [];
  const provenance = new Map<Rule, string>();

  for (const layer of layers) {
    if (layer.policy.defaultMode) {
      const layerMode = mapMode(layer.policy.defaultMode);
      mode = ceilingAbove
        ? mapMode(mostRestrictiveMode(mode, layerMode) ?? mode)
        : layerMode;
    }
    for (const rule of collectRules(layer.policy)) {
      allRules.push(rule);
      provenance.set(rule, layer.source);
    }
    if (layer.ceiling === true) ceilingAbove = true;
  }

  const rules = deduplicateRules(allRules);
  const delegation = delegationLimits(
    ...layers.map((layer) => layer.policy.delegation),
  );

  return {
    defaultMode: mode,
    ...(rules.length > 0 ? { rules, provenance } : {}),
    ...(layers.some((layer) => layer.ceiling === true)
      ? {
          layers: layers.map((layer) => ({
            source: layer.source,
            ceiling: layer.ceiling === true,
          })),
        }
      : {}),
    ...(delegation === undefined ? {} : { delegation }),
  };
}

function mergeLayers(layers: DecodedLayer[]): PermissionPolicy {
  return mergeLayerPolicies(
    layers.map((layer) => ({
      source: layer.file.path,
      policy: layer.policy,
      ceiling: layer.policy.ceiling === true,
    })),
  );
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
  const { layers } = await loadLayers(options.cwd);
  return mergeLayers(layers);
}

/** Thrown to `watchPolicy`'s error callback when a layer file is there but cannot be used. */
export class PolicyLoadError extends Error {
  /** One line per file that could not be read, parsed or validated. */
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(`policy files could not be used:\n  ${failures.join("\n  ")}`);
    this.name = "PolicyLoadError";
    this.failures = failures;
  }
}

/** A running watch. */
export interface PolicyWatcher {
  /** Stop watching; no callback runs after this returns. */
  close(): void;
}

/** How long changes are collected before the policy is reloaded once. */
const RELOAD_DEBOUNCE_MS = 50;

/**
 * How long after the watch starts, and after a directory starts being watched, the layers are read
 * once more. The operating system can establish a watch after `fs.watch` returns, and a change made
 * in that window is never delivered, which would leave the reported policy stale until the next
 * change.
 */
const SETTLE_RECHECK_MS = 250;

/** The file and directory names that can hold a layer, so other changes are ignored. */
const RELEVANT_NAMES: ReadonlySet<string> = new Set(
  Object.values(AGENT_FILES).flatMap((def) =>
    [def.name, "localName" in def ? def.localName : undefined].flatMap(
      (path) => (path === undefined ? [] : path.split("/")),
    ),
  ),
);

/** The directories that hold, or could come to hold, a layer file for a walk up from `cwd`. */
function directoriesToWatch(cwd: string): string[] {
  const directories = new Set<string>();
  let current = resolve(cwd);
  for (;;) {
    directories.add(current);
    for (const def of Object.values(AGENT_FILES)) {
      for (const name of [
        def.name,
        "localName" in def ? def.localName : undefined,
      ]) {
        if (name !== undefined) directories.add(dirname(join(current, name)));
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...directories].filter((directory) => existsSync(directory));
}

/** What identifies a policy for change detection: its decisions and where each rule came from. */
function policyKey(policy: PermissionPolicy): string {
  return JSON.stringify({
    defaultMode: policy.defaultMode,
    rules: policy.rules?.map((rule) => [rule, policy.provenance?.get(rule)]),
    layers: policy.layers,
    delegation: policy.delegation,
  });
}

/**
 * Watch the layer files of a walk up from `options.cwd`. `onChange` is called with the policy as it
 * first loads, and again each time a reload gives a different one, so a host needs no separate
 * {@link loadPolicy} call: one that loaded the policy first could miss a change made while the
 * watch was starting.
 *
 * A layer file that is there but cannot be read, parsed or validated (an editor mid-write, say) is
 * reported to `onError` as a {@link PolicyLoadError}, and no policy is reported until every file
 * loads again: a policy missing that layer would be looser than the one in force.
 */
export function watchPolicy(
  options: PolicyLoadOptions,
  onChange: (policy: PermissionPolicy) => void,
  onError: (error: Error) => void,
): PolicyWatcher {
  const { cwd } = options;
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let lastKey: string | undefined;

  /** Watch every directory that should be watched, returning whether any was new. */
  const syncWatchers = (): boolean => {
    let added = false;
    const wanted = new Set(directoriesToWatch(cwd));
    for (const [directory, watcher] of watchers) {
      if (!wanted.has(directory)) {
        watcher.close();
        watchers.delete(directory);
      }
    }
    for (const directory of wanted) {
      if (watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, (_event, filename) => {
          if (filename === null || RELEVANT_NAMES.has(filename)) schedule();
        });
        watcher.on("error", (error) => {
          if (!closed) onError(error);
        });
        watchers.set(directory, watcher);
        added = true;
      } catch (error) {
        // The directory went away between listing and watching; the next reload lists again.
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw error;
        }
      }
    }
    return added;
  };

  const reload = async (): Promise<void> => {
    const { layers, failures } = await loadLayers(cwd);
    if (closed) return;
    // A file created in a directory before it was watched raised no event, so read again once it is.
    if (syncWatchers()) scheduleRecheck();
    if (failures.length > 0) {
      onError(new PolicyLoadError(failures));
      return;
    }
    const policy = mergeLayers(layers);
    const key = policyKey(policy);
    if (key === lastKey) return;
    lastKey = key;
    onChange(policy);
  };

  // Reloads run one at a time, in the order the changes came; the first one reports the initial policy.
  let running: Promise<void> = reload().catch((error: unknown) => {
    if (!closed)
      onError(error instanceof Error ? error : new Error(String(error)));
  });
  const schedule = (): void => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(reload).catch((error: unknown) => {
        if (!closed)
          onError(error instanceof Error ? error : new Error(String(error)));
      });
    }, RELOAD_DEBOUNCE_MS);
  };

  const scheduleRecheck = (): void => {
    if (closed) return;
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(schedule, SETTLE_RECHECK_MS);
  };
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;

  syncWatchers();
  scheduleRecheck();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(recheckTimer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
