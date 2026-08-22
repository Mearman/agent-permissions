/**
 * Permission policy sync — detect, merge, and write agent configs.
 *
 * Walks up the directory tree, detects all agent permission configs,
 * decodes into canonical rules, merges them, and writes back.
 *
 * Merge semantics:
 *   - rules: union with deny-first (deny > ask > allow for same tool/pattern)
 *   - defaultMode: most restrictive wins
 *   - agent-specific fields (sandbox, profiles, network): from canonical only
 *
 * Write-back:
 *   - `.agents/permissions.json` always gets the full merged canonical form
 *   - Native agent configs get their encoded form from the canonical merge
 *   - `.agents/permissions.local.json` is read but never written
 *   - Codex skipped (TOML), Crush skipped (no file)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { AgentPermissionPolicy, type Rule } from "./schema.ts";
import { CODECS, type AgentId } from "./compat/codecs.ts";
import {
  collectRules,
  deduplicateRules,
  mostRestrictiveMode,
} from "./evaluate.ts";
import {
  AGENT_FILES,
  defaultFilePath,
  type AgentFileDef,
  parseAgentFile,
  stringifyAgentFile,
  validatePolicy,
  decodeNative,
} from "./agent-files.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncOptions {
  /** Starting directory. */
  cwd: string;
  /** Number of parent directories to ascend (0 = cwd only). Infinity = root. */
  up: number;
  /** Agents to include in bidirectional sync. Empty = all detected. */
  with: AgentId[];
  /** Agents to exclude from bidirectional sync. */
  without: AgentId[];
  /** Apply changes without prompting. */
  yes: boolean;
  /** Show changes only, never write. */
  dryRun: boolean;
  /** Create config files that don't exist. */
  create: boolean;
  /** Show verbose output (rule provenance). */
  verbose: boolean;
  /** Write .bak files before overwriting. */
  backup: boolean;
}

export interface SyncResult {
  /** Per-file changes that would be applied. */
  changes: FileChange[];
  /** Whether changes were applied. */
  applied: boolean;
}

export interface FileChange {
  /** Absolute path to the file. */
  path: string;
  /** Agent this file belongs to. */
  agent: AgentId | "canonical";
  /** "create" | "update" */
  kind: "create" | "update";
  /** Current content (null for new files). */
  current: string | null;
  /** Proposed content. */
  proposed: string;
}

// ---------------------------------------------------------------------------
// Agent file detection
// ---------------------------------------------------------------------------

interface AgentFile {
  agent: AgentId | "canonical";
  /** Absolute path to the config file. */
  path: string;
  /** Whether this is a local override (read-only, never written). */
  local: boolean;
}

/** Detect which agent files exist in a directory. */
function detectFiles(dir: string): AgentFile[] {
  const found: AgentFile[] = [];

  for (const [agent, def] of Object.entries(AGENT_FILES) as [
    AgentId | "canonical",
    AgentFileDef,
  ][]) {
    if (def.global) continue;
    const main = join(dir, def.name);
    if (existsSync(main)) {
      found.push({ agent, path: main, local: false });
    }
    if (def.localName) {
      const local = join(dir, def.localName);
      if (existsSync(local)) {
        found.push({ agent, path: local, local: true });
      }
    }
  }

  return found;
}

/** Walk up from cwd, collecting agent files. */
function collectFiles(
  cwd: string,
  up: number,
  globalAgents: Set<AgentId>,
): AgentFile[] {
  const files: AgentFile[] = [];
  let current = resolve(cwd);
  let remaining = up === Infinity ? Number.MAX_SAFE_INTEGER : up + 1;

  while (remaining > 0) {
    files.push(...detectFiles(current));
    remaining--;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const [agent, def] of Object.entries(AGENT_FILES) as [
    AgentId | "canonical",
    AgentFileDef,
  ][]) {
    if (!def.global || !globalAgents.has(agent as AgentId)) continue;
    const path = defaultFilePath(agent, cwd);
    if (existsSync(path)) files.push({ agent, path, local: false });
  }

  return files;
}

// ---------------------------------------------------------------------------
// Reading and decoding
// ---------------------------------------------------------------------------

interface DecodedSource {
  file: AgentFile;
  policy: AgentPermissionPolicy;
}

async function readAndDecode(
  file: AgentFile,
  agentFilter: Set<string> | undefined,
): Promise<DecodedSource | undefined> {
  // Skip if --with/--without excludes this agent
  if (
    agentFilter &&
    !agentFilter.has(file.agent) &&
    file.agent !== "canonical"
  ) {
    return undefined;
  }

  const def = AGENT_FILES[file.agent];

  // Skip agents without extract/wrap (crush, codex) or without a file def
  if (def.extract === undefined) return undefined;

  // Read and parse
  let content: string;
  try {
    content = await readFile(file.path, "utf-8");
  } catch {
    return undefined;
  }
  const parsed = parseAgentFile(file.agent, content, file.path);
  if (!parsed.ok) return undefined;

  // Canonical files parse directly
  if (file.agent === "canonical") {
    const validated = validatePolicy(parsed.value);
    if (!validated.ok) return undefined;
    return { file, policy: validated.value };
  }

  // Native files — extract, decode, validate
  const result = decodeNative(file.agent, parsed.value);
  if (!result.ok) return undefined;
  return { file, policy: result.value };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

function mergePolicies(sources: DecodedSource[]): AgentPermissionPolicy {
  if (sources.length === 0) {
    return {};
  }

  let defaultMode: string | undefined;
  const allRules: Rule[] = [];
  const additionalDirectories: string[] = [];
  let sandbox: AgentPermissionPolicy["sandbox"];
  let network: AgentPermissionPolicy["network"];
  let profiles: AgentPermissionPolicy["profiles"];
  let activeProfile: string | undefined;
  let delegation: AgentPermissionPolicy["delegation"];
  let env: AgentPermissionPolicy["env"];

  for (const { policy } of sources) {
    // defaultMode: most restrictive wins
    defaultMode = mostRestrictiveMode(defaultMode, policy.defaultMode);

    // Rules: collect then deduplicate with deny-first priority
    allRules.push(...collectRules(policy));

    // Additional directories: union
    if (policy.permissions?.additionalDirectories) {
      for (const dir of policy.permissions.additionalDirectories) {
        if (!additionalDirectories.includes(dir)) {
          additionalDirectories.push(dir);
        }
      }
    }

    // Agent-specific fields: take from canonical source if present,
    // otherwise from the first source that has them
    if (policy.sandbox) sandbox = { ...sandbox, ...policy.sandbox };
    if (policy.network) network = { ...network, ...policy.network };
    if (policy.profiles) profiles = { ...(profiles ?? {}), ...policy.profiles };
    if (policy.activeProfile) activeProfile = policy.activeProfile;
    if (policy.delegation) delegation = { ...delegation, ...policy.delegation };
    if (policy.env) env = { ...(env ?? {}), ...policy.env };
  }

  const rules = deduplicateRules(allRules);

  const result: AgentPermissionPolicy = {};

  if (defaultMode)
    result.defaultMode = defaultMode as AgentPermissionPolicy["defaultMode"];

  if (rules.length > 0) result.rules = rules;

  if (additionalDirectories.length > 0) {
    result.permissions = { additionalDirectories };
  }

  if (sandbox) result.sandbox = sandbox;
  if (network) result.network = network;
  if (profiles && Object.keys(profiles).length > 0) result.profiles = profiles;
  if (activeProfile) result.activeProfile = activeProfile;
  if (delegation) result.delegation = delegation;
  if (env && Object.keys(env).length > 0) result.env = env;

  return result;
}

// ---------------------------------------------------------------------------
// Encoding and write-back
// ---------------------------------------------------------------------------

interface WriteTarget {
  agent: AgentId | "canonical";
  path: string;
  content: string;
  exists: boolean;
}

function computeWriteTargets(
  cwd: string,
  merged: AgentPermissionPolicy,
  sources: DecodedSource[],
  agentFilter: Set<string> | undefined,
  create: boolean,
  globalAgents: Set<AgentId>,
): WriteTarget[] {
  const targets: WriteTarget[] = [];

  // Always write canonical at cwd (unless excluded)
  const canonicalPath = join(cwd, ".agents", "permissions.json");
  const schemaUrl =
    "https://github.com/Mearman/agent-permissions/releases/latest/download/agent-permissions.schema.json";
  const canonicalWithSchema = { $schema: schemaUrl, ...merged };
  if (!agentFilter || agentFilter.has("canonical")) {
    targets.push({
      agent: "canonical",
      path: canonicalPath,
      content: JSON.stringify(canonicalWithSchema, null, 2) + "\n",
      exists: existsSync(canonicalPath),
    });
  }

  // Write native configs at cwd
  for (const agent of Object.keys(CODECS) as AgentId[]) {
    if (agentFilter && !agentFilter.has(agent)) continue;
    if (agent === "codex" || agent === "crush") continue; // TOML / no file

    const def = AGENT_FILES[agent];
    if (def.global && !globalAgents.has(agent)) continue;
    const filePath = defaultFilePath(agent, cwd);
    const fileExists = existsSync(filePath);

    if (!fileExists && !create) continue;

    // Check if there's a source from this agent (or create is enabled)
    const hasSource = sources.some((s) => s.file.agent === agent);
    if (!hasSource && !create) continue;

    const codec = CODECS[agent];
    let encoded: unknown;
    try {
      encoded = codec.encode(merged);
    } catch {
      continue;
    }

    // Wrap in native config structure (e.g. { permissions: ... })
    if (def.wrap) encoded = def.wrap(encoded);

    targets.push({
      agent,
      path: filePath,
      content: stringifyAgentFile(agent, encoded, false),
      exists: fileExists,
    });
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Diff display
// ---------------------------------------------------------------------------

function formatChange(change: FileChange): string {
  const kind = change.kind === "create" ? "+" : "~";
  const label = change.agent === "canonical" ? "canonical" : change.agent;

  let output = `${kind} ${label}: ${change.path}\n`;

  if (change.kind === "create") {
    output += "  (new file)\n";
    // Show first few lines
    const lines = change.proposed.split("\n").slice(0, 10);
    for (const line of lines) {
      output += `  ${line}\n`;
    }
    if (change.proposed.split("\n").length > 10) {
      output += "  ...\n";
    }
  } else {
    // Show diff-like summary
    const currentLines = (change.current ?? "").split("\n");
    const proposedLines = change.proposed.split("\n");

    const added = proposedLines.filter((l) => !currentLines.includes(l));
    const removed = currentLines.filter((l) => !proposedLines.includes(l));

    for (const line of removed.slice(0, 20)) {
      if (line.trim()) output += `  - ${line}\n`;
    }
    for (const line of added.slice(0, 20)) {
      if (line.trim()) output += `  + ${line}\n`;
    }

    if (added.length > 20 || removed.length > 20) {
      output += `  ... (${String(added.length)} additions, ${String(removed.length)} removals)\n`;
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

export async function sync(options: SyncOptions): Promise<SyncResult> {
  const {
    cwd,
    up,
    with: withList,
    without: withoutList,
    yes,
    dryRun,
    create,
    verbose,
    backup,
  } = options;

  // Build agent filter from --with/--without
  const agentFilter = buildAgentFilter(withList, withoutList);

  const files = collectFiles(cwd, up, new Set(withList));

  if (files.length === 0) {
    process.stderr.write(
      "No permission configs found. Create .agents/permissions.json to get started.\n",
    );
    return { changes: [], applied: false };
  }

  if (verbose) {
    process.stderr.write("Detected config files:\n");
    for (const f of files) {
      const local = f.local ? " (local, read-only)" : "";
      process.stderr.write(`  ${f.agent}: ${f.path}${local}\n`);
    }
    process.stderr.write("\n");
  }

  // 2. Read and decode all sources
  const sources: DecodedSource[] = [];
  for (const file of files) {
    // Skip local files for write-back consideration
    const decoded = await readAndDecode(file, agentFilter);
    if (decoded) {
      sources.push(decoded);
      if (verbose) {
        const rules = collectRules(decoded.policy);
        process.stderr.write(
          `  ${file.agent} (${file.path}): ${String(rules.length)} rules, mode=${decoded.policy.defaultMode ?? "standard"}\n`,
        );
      }
    }
  }

  if (sources.length === 0) {
    process.stderr.write("No readable permission configs found.\n");
    return { changes: [], applied: false };
  }

  // 3. Merge all sources
  const merged = mergePolicies(sources);

  if (verbose) {
    const rules = collectRules(merged);
    process.stderr.write(
      `\nMerged: ${String(rules.length)} rules, mode=${merged.defaultMode ?? "standard"}\n`,
    );
  }

  // 4. Compute write targets
  const targets = computeWriteTargets(
    cwd,
    merged,
    sources,
    agentFilter,
    create,
    new Set(withList),
  );

  if (targets.length === 0) {
    process.stderr.write("No write targets.\n");
    return { changes: [], applied: false };
  }

  // 5. Build changes
  const changes: FileChange[] = [];
  for (const target of targets) {
    let current: string | null = null;
    if (target.exists) {
      try {
        current = await readFile(target.path, "utf-8");
      } catch {
        current = null;
      }
    }

    // Skip if content is semantically identical (compare parsed JSON)
    if (current !== null) {
      try {
        const currentParsed: unknown = JSON.parse(current);
        const proposedParsed: unknown = JSON.parse(target.content);
        if (JSON.stringify(currentParsed) === JSON.stringify(proposedParsed)) {
          continue;
        }
      } catch {
        // Fall through to string comparison if parse fails
        if (current === target.content) continue;
      }
    } else if (target.content === "") {
      continue;
    }

    changes.push({
      path: target.path,
      agent: target.agent,
      kind: target.exists ? "update" : "create",
      current,
      proposed: target.content,
    });
  }

  if (changes.length === 0) {
    process.stderr.write("Already in sync — no changes needed.\n");
    return { changes: [], applied: true };
  }

  // 6. Display changes
  process.stderr.write("\nChanges:\n\n");
  for (const change of changes) {
    process.stderr.write(formatChange(change));
    process.stderr.write("\n");
  }

  // 7. Apply or prompt
  if (dryRun) {
    process.stderr.write("(dry run — no changes written)\n");
    return { changes, applied: false };
  }

  if (!yes) {
    process.stderr.write("Apply these changes? [y/N] ");
    const answer = await readLine();
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      process.stderr.write("Aborted.\n");
      return { changes, applied: false };
    }
  }

  // 8. Write files
  for (const change of changes) {
    // Backup if requested and file exists
    if (backup && change.current !== null) {
      await writeFile(change.path + ".bak", change.current);
    }

    // Ensure directory exists
    const dir = dirname(change.path);
    await mkdir(dir, { recursive: true });

    await writeFile(change.path, change.proposed);
  }

  process.stderr.write(`Applied ${String(changes.length)} change(s).\n`);
  return { changes, applied: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data: string) => {
      resolve(data.trim());
    });
  });
}

/**
 * Build an agent filter from --with and --without lists.
 * Returns undefined when no filtering is needed (all agents included).
 * --with and --without are mutually exclusive.
 */
function buildAgentFilter(
  withList: AgentId[],
  withoutList: AgentId[],
): Set<string> | undefined {
  if (withList.length > 0) {
    // --with: only include listed agents + canonical
    const filter = new Set<string>(withList);
    filter.add("canonical");
    return filter;
  }

  if (withoutList.length > 0) {
    // --without: include all except listed
    const allAgents = [...Object.keys(CODECS), "canonical"];
    const excluded = new Set(withoutList);
    return new Set(allAgents.filter((a) => !excluded.has(a as AgentId)));
  }

  return undefined;
}
