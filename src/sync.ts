/**
 * Permission policy sync — detect, merge, and write agent configs.
 *
 * Walks up the directory tree, detects all agent permission configs, decodes into canonical rules,
 * merges them, and writes back.
 *
 * Merge semantics:
 *
 * - Rules: union with deny-first (deny > ask > allow for same tool/pattern)
 * - DefaultMode: most restrictive wins
 * - Agent-specific fields (sandbox, profiles, network): from canonical only
 *
 * Write-back:
 *
 * - `.agents/permissions.json` always gets the full merged canonical form
 * - Native agent configs get their encoded form from the canonical merge
 * - `.agents/permissions.local.json` is read but never written
 * - Codex skipped (TOML), Crush skipped (no file)
 * - Oh My Pi: the project's `.omp/config.yml` is read and written like any native config, and the
 *   global config in its agent directory is read too, since OMP replaces the global
 *   `bash.patterns` with the project's rather than joining them; the global file is written only
 *   with `ompGlobal`. Only `bash.patterns` and `tools.approvalMode` change, the rest of the YAML
 *   is kept, and the old file is always backed up first.
 */

import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { AgentPermissionPolicy, type Rule } from "./schema.ts";
import { CODECS, OmpEncoded, type AgentId } from "./compat/codecs.ts";
import { UnsupportedCapabilityError } from "./compat/unsupported.ts";
import { SyncRefusedError, type SyncRefusalReason } from "./sync-error.ts";

export { SyncRefusedError, type SyncRefusalReason } from "./sync-error.ts";
import { isAgentId, isPermissionMode } from "./guards.ts";
import {
  collectRules,
  deduplicateRules,
  mostRestrictiveMode,
} from "./evaluate.ts";
import {
  AGENT_FILES,
  assertUnchanged,
  decodeNative,
  editJsonConfig,
  editOmpConfig,
  isBlank,
  nativeConfigPath,
  nativeFileNames,
  nativePayload,
  ompGlobalConfigPath,
  parseAgentFile,
  parseJson,
  parseNativeJson,
  readIfPresent,
  renderNativeConfig,
  validatePolicy,
  writeBackup,
  writeFileAtomic,
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
  /** Write .bak files before overwriting. Oh My Pi's config is always backed up. */
  backup: boolean;
  /** Oh My Pi's agent directory, which holds its global config (see `defaultOmpAgentDir`). */
  ompAgentDir: string;
  /** Also write Oh My Pi's global config, which every OMP session on the machine reads. */
  ompGlobal: boolean;
  /**
   * A caller that syncs repeatedly (the daemon) passes the same map each time so a warning about a
   * source is written once per change of that file's content, not on every run.
   */
  warned?: Map<string, string>;
}

export interface SyncResult {
  /** Per-file changes that would be applied. */
  changes: FileChange[];
  /** Whether changes were applied. */
  applied: boolean;
  /**
   * Agents whose native format cannot enforce a rule in the merged policy. When any are listed
   * nothing is written, since a partial sync would leave the refused agents on a looser policy.
   */
  refused: UnsupportedCapabilityError[];
  /** Whether the changes were declined at the prompt, by an answer or by the end of input. */
  aborted: boolean;
}

/**
 * Thrown when writing the planned files stops part way. Nothing is rolled back: `written` lists the
 * files that were replaced and `notWritten` the rest, the failed one first.
 */
export class SyncWriteError extends Error {
  readonly written: readonly string[];
  readonly notWritten: readonly string[];

  constructor(
    cause: unknown,
    written: readonly string[],
    notWritten: readonly string[],
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `${reason}. Written: ${written.length > 0 ? written.join(", ") : "none"}. Not written: ${notWritten.join(", ")}.`,
      { cause },
    );
    this.name = "SyncWriteError";
    this.written = written;
    this.notWritten = notWritten;
  }
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

  for (const [key, def] of Object.entries(AGENT_FILES)) {
    if (!isAgentId(key) && key !== "canonical") continue;
    const agent: AgentId | "canonical" = key;
    for (const name of nativeFileNames(def)) {
      const main = join(dir, name);
      if (existsSync(main)) {
        found.push({ agent, path: main, local: false });
      }
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
function collectFiles(cwd: string, up: number): AgentFile[] {
  const files: AgentFile[] = [];
  let current = resolve(cwd);
  let remaining = up === Infinity ? Number.MAX_SAFE_INTEGER : up + 1;

  while (remaining > 0) {
    const found = detectFiles(current);
    files.push(...found);
    remaining--;

    const parent = dirname(current);
    if (parent === current) break; // reached root

    current = parent;
  }

  return files;
}

// ---------------------------------------------------------------------------
// Reading and decoding
// ---------------------------------------------------------------------------

export interface DecodedSource {
  file: AgentFile;
  policy: AgentPermissionPolicy;
}

/** What reading sources needs to know about this run. */
interface ReadContext {
  agentFilter: Set<string> | undefined;
  /** The files this run would write: only a problem with one of these stops the sync. */
  writePaths: ReadonlySet<string>;
  /** Report a source that was left out, once per change of its content. */
  note: (path: string, reason: string, content?: string) => void;
}

/** A reporter that writes each warning to stderr, once per change when given a memory. */
function makeNote(
  warned: Map<string, string> | undefined,
): ReadContext["note"] {
  return (path, reason, content) => {
    const text = reason.startsWith(path) ? reason : `${path}: ${reason}`;
    const key = `${text}\0${content === undefined ? "" : createHash("sha1").update(content).digest("hex")}`;
    if (warned !== undefined) {
      if (warned.get(path) === key) return;
      warned.set(path, key);
    }
    process.stderr.write(`warning: ${text}\n`);
  };
}

/**
 * Read one source. A source that cannot be used (unreadable, not valid UTF-8, not valid for its
 * agent, or holding a value the codec cannot decode) stops the sync only when sync would write that
 * file, since writing would replace entries nobody read; anywhere else (an ancestor's config, a
 * local override) it is left out with a warning, and the agent still applies it itself.
 */
async function readAndDecode(
  file: AgentFile,
  context: ReadContext,
): Promise<DecodedSource | undefined> {
  const { agentFilter, writePaths, note } = context;
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

  const writes = !file.local && writePaths.has(file.path);
  const unusable = (
    reasonCode: SyncRefusalReason,
    reason: string,
    content?: string,
  ): undefined => {
    if (writes) {
      throw new SyncRefusedError(
        file.path,
        reasonCode,
        reason.startsWith(`${file.path}: `)
          ? reason.slice(file.path.length + 2)
          : reason,
      );
    }
    note(file.path, `${reason} (left out of the merge)`, content);
    return undefined;
  };

  let content: string;
  try {
    content = await readFileRequired(file.path);
  } catch (error) {
    if (writes) throw error;
    note(
      file.path,
      `${error instanceof Error ? error.message : String(error)} (left out of the merge)`,
    );
    return undefined;
  }
  if (isBlank(content)) return undefined;

  // OMP's config is written by editing it in place, so one that cannot be read is an error when it
  // is to be written: skipping it would let the write replace entries nobody read.
  if (file.agent === "omp") {
    const parsed = parseAgentFile("omp", content, file.path);
    if (!parsed.ok) {
      unusable("invalid-format", parsed.error, content);
      return;
    }
    const result = decodeNative("omp", parsed.value);
    if (!result.ok) {
      unusable("undecodable", result.error, content);
      return;
    }
    return { file, policy: result.value };
  }

  // Canonical files parse directly. One in the directory sync writes that cannot be used stops the
  // sync, since writing would replace rules nobody read; any other is left out of the merge.
  if (file.agent === "canonical") {
    const parsed = parseJson(content, file.path);
    if (!parsed.ok) {
      unusable("invalid-format", parsed.error, content);
      return;
    }
    const validated = validatePolicy(parsed.value);
    if (!validated.ok) {
      unusable("undecodable", validated.error, content);
      return;
    }
    return { file, policy: validated.value };
  }

  const parsed = parseNativeJson(content, file.path, def.jsonc === true);
  if (!parsed.ok) {
    note(file.path, `${parsed.error} (left out of the merge)`, content);
    return undefined;
  }

  // A native file without a permissions payload has nothing to read; one whose payload cannot be
  // decoded stops the sync when it is to be written, because the write would replace entries nobody read.
  if (nativePayload(file.agent, parsed.value) === undefined) return undefined;
  const result = decodeNative(file.agent, parsed.value);
  if (!result.ok) {
    unusable("undecodable", result.error, content);
    return;
  }
  return { file, policy: result.value };
}

/** A file's text; one that exists and cannot be read is an error naming it. */
async function readFileRequired(path: string): Promise<string> {
  const content = await readIfPresent(path);
  if (content === null) {
    throw new SyncRefusedError(
      path,
      "unreadable",
      "vanished while it was being read",
    );
  }
  return content;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/** Two delegation blocks as one that is at least as strict as each, keeping the other keys of both. */
function mergeDelegation(
  a: AgentPermissionPolicy["delegation"],
  b: NonNullable<AgentPermissionPolicy["delegation"]>,
): NonNullable<AgentPermissionPolicy["delegation"]> {
  const merged = { ...a, ...b };
  const depths = [a?.maxDepth, b.maxDepth].filter((d) => d !== undefined);
  if (depths.length > 0) merged.maxDepth = Math.min(...depths);
  const barred = [...(a?.nonDelegable ?? []), ...(b.nonDelegable ?? [])];
  if (barred.length > 0) merged.nonDelegable = [...new Set(barred)];
  return merged;
}

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
  const roles: NonNullable<AgentPermissionPolicy["roles"]> = {};

  for (const { policy } of sources) {
    // defaultMode: most restrictive wins
    defaultMode = mostRestrictiveMode(defaultMode, policy.defaultMode);

    // Rules: collect then deduplicate with deny-first priority. Roles are kept as roles below, so
    // the written file is not rewritten into rules that carry a role condition.
    allRules.push(
      ...collectRules({ rules: policy.rules, permissions: policy.permissions }),
    );

    // Roles: each role's lists joined across sources
    for (const [role, tiers] of Object.entries(policy.roles ?? {})) {
      const joined = (roles[role] ??= {});
      for (const tier of ["deny", "ask", "allow"] as const) {
        const merged = [...(joined[tier] ?? []), ...(tiers[tier] ?? [])];
        if (merged.length > 0) joined[tier] = [...new Set(merged)];
      }
    }

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
    // Delegation limits only tighten: the shallowest maxDepth, every nonDelegable rule
    if (policy.delegation) {
      delegation = mergeDelegation(delegation, policy.delegation);
    }
    if (policy.env) env = { ...(env ?? {}), ...policy.env };
  }

  const rules = deduplicateRules(allRules);

  const result: AgentPermissionPolicy = {};

  if (defaultMode !== undefined && isPermissionMode(defaultMode))
    result.defaultMode = defaultMode;

  if (rules.length > 0) result.rules = rules;

  if (additionalDirectories.length > 0) {
    result.permissions = { additionalDirectories };
  }

  if (sandbox) result.sandbox = sandbox;
  if (network) result.network = network;
  if (profiles && Object.keys(profiles).length > 0) result.profiles = profiles;
  if (activeProfile) result.activeProfile = activeProfile;
  if (delegation) result.delegation = delegation;
  if (Object.keys(roles).length > 0) result.roles = roles;
  if (env && Object.keys(env).length > 0) result.env = env;

  return result;
}

// ---------------------------------------------------------------------------
// Encoding and write-back
// ---------------------------------------------------------------------------

interface WriteTarget {
  agent: AgentId | "canonical";
  path: string;
  /** The file's new content, given its current content (`null` for a new file). */
  render: (current: string | null) => string;
  exists: boolean;
}

/**
 * The top-level keys of the canonical file that sync owns: exactly what the merge produces. Every
 * other key (`$schema` of an existing file, `ceiling`, `with`, `without`, `up`, `sync`, and any the
 * schema gains) is the user's and is never rewritten.
 */
export const SYNC_OWNED_KEYS: readonly string[] = [
  "defaultMode",
  "rules",
  "permissions",
  "sandbox",
  "network",
  "profiles",
  "activeProfile",
  "delegation",
  "roles",
  "env",
];

const SCHEMA_URL =
  "https://github.com/ExaDev/agent-permissions/releases/latest/download/agent-permissions.schema.json";

/** The rules of a policy as a sorted list of their JSON, so two policies compare by content. */
function ruleKeys(rules: readonly Rule[]): string[] {
  return rules.map((rule) => JSON.stringify(rule)).sort();
}

/**
 * The canonical file's content after a sync. A new or empty file is the merged policy with its
 * schema reference. An existing file is edited as text: only the keys the merge produces are
 * replaced (or removed when the merge has none), so everything else in it survives byte for byte.
 * The user's `permissions.allow`, `deny` and `ask` lists are folded into `rules` by the merge, and
 * are left as written unless the merge changed the rules.
 *
 * @param own The policy decoded from this file, when it could be read.
 */
function renderCanonical(
  current: string | null,
  merged: AgentPermissionPolicy,
  own: AgentPermissionPolicy | undefined,
  path: string,
): string {
  if (current === null || isBlank(current)) {
    return JSON.stringify({ $schema: SCHEMA_URL, ...merged }, null, 2) + "\n";
  }
  const rulesUnchanged =
    own !== undefined &&
    isDeepStrictEqual(
      ruleKeys(
        deduplicateRules(
          collectRules({ rules: own.rules, permissions: own.permissions }),
        ),
      ),
      ruleKeys(merged.rules ?? []),
    );
  const paths = SYNC_OWNED_KEYS.flatMap((key) => {
    if (key === "rules") return rulesUnchanged ? [] : [[key]];
    if (key === "permissions") {
      return rulesUnchanged ? [[key, "additionalDirectories"]] : [[key]];
    }
    return [[key]];
  });
  return editJsonConfig(current, merged, paths, false, path);
}

/** What sync needs from a codec, so the encoding step can be tested without real agent formats. */
interface Encoder {
  encode(canonical: AgentPermissionPolicy): unknown;
}

/**
 * Work out the files to write. An agent whose codec refuses the merged policy is reported in
 * `refused` and never skipped silently.
 *
 * @param ompGlobalPath Oh My Pi's global config, written as well when given.
 */
export function computeWriteTargets(
  cwd: string,
  merged: AgentPermissionPolicy,
  sources: DecodedSource[],
  agentFilter: Set<string> | undefined,
  create: boolean,
  codecs: Readonly<Record<AgentId, Encoder>> = CODECS,
  ompGlobalPath?: string,
): { targets: WriteTarget[]; refused: UnsupportedCapabilityError[] } {
  const targets: WriteTarget[] = [];
  const refused: UnsupportedCapabilityError[] = [];

  // Always write canonical at cwd (unless excluded)
  const canonicalPath = join(cwd, ".agents", "permissions.json");
  if (!agentFilter || agentFilter.has("canonical")) {
    const own = sources.find(
      (s) =>
        s.file.agent === "canonical" &&
        !s.file.local &&
        s.file.path === canonicalPath,
    )?.policy;
    targets.push({
      agent: "canonical",
      path: canonicalPath,
      render: (current) => renderCanonical(current, merged, own, canonicalPath),
      exists: existsSync(canonicalPath),
    });
  }

  // Write native configs at cwd
  for (const key of Object.keys(codecs)) {
    if (!isAgentId(key)) continue;
    const agent: AgentId = key;
    if (agentFilter && !agentFilter.has(agent)) continue;
    if (agent === "codex" || agent === "crush") continue; // TOML / no file

    const def = AGENT_FILES[agent];
    const filePath = nativeConfigPath(cwd, def);
    const fileExists = existsSync(filePath);

    if (!fileExists && !create) continue;

    // Check if there's a source from this agent (or create is enabled)
    const hasSource = sources.some((s) => s.file.agent === agent);
    if (!hasSource && !create) continue;

    let encoded: unknown;
    try {
      encoded = codecs[agent].encode(merged);
    } catch (e) {
      if (e instanceof UnsupportedCapabilityError) {
        refused.push(e);
        continue;
      }
      throw e;
    }

    if (agent === "omp") {
      targets.push(ompTarget(filePath, OmpEncoded.parse(encoded)));
      continue;
    }

    targets.push({
      agent,
      path: filePath,
      // A native config also holds the user's other settings, so only the paths the codec models change.
      render: (current) =>
        renderNativeConfig(agent, current, encoded, filePath),
      exists: fileExists,
    });
  }

  // OMP's global config, when asked for, unless the project file's encoding was already refused
  if (
    ompGlobalPath !== undefined &&
    (!agentFilter || agentFilter.has("omp")) &&
    (existsSync(ompGlobalPath) || create) &&
    !refused.some((r) => r.agent === "omp")
  ) {
    try {
      targets.push(
        ompTarget(ompGlobalPath, OmpEncoded.parse(codecs.omp.encode(merged))),
      );
    } catch (e) {
      if (!(e instanceof UnsupportedCapabilityError)) throw e;
      refused.push(e);
    }
  }

  return { targets, refused };
}

/** An OMP config target, edited in place so only the keys the codec writes change. */
function ompTarget(path: string, encoded: OmpEncoded): WriteTarget {
  return {
    agent: "omp",
    path,
    render: (current) => editOmpConfig(current, encoded),
    exists: existsSync(path),
  };
}

/** Whether a file's current and proposed content hold the same data, whatever the formatting. */
function sameData(
  agent: AgentId | "canonical",
  current: string,
  proposed: string,
): boolean {
  if (agent === "omp") {
    return (
      JSON.stringify(parseYaml(current)) === JSON.stringify(parseYaml(proposed))
    );
  }
  // A JSONC file's text differs from its data by comments, so both sides are read leniently.
  const currentParsed = parseNativeJson(current, "current", true);
  const proposedParsed = parseNativeJson(proposed, "proposed", true);
  if (!currentParsed.ok || !proposedParsed.ok) return current === proposed;
  return (
    JSON.stringify(currentParsed.value) === JSON.stringify(proposedParsed.value)
  );
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

/**
 * Detect, merge and write the permission configs found from `options.cwd` upward.
 *
 * Rejects, writing nothing, with a {@link SyncRefusedError} naming the file and a machine-readable
 * reason when a file sync would write cannot be used: it cannot be read, is not valid UTF-8 or not
 * valid for its agent, holds a value its codec cannot decode, is a link to nothing, changed after
 * it was read, or belongs to another user. A source that sync would not write (an ancestor's
 * config, a local override) is left out of the merge with a warning instead. Rejects with a
 * {@link SyncWriteError} when applying stops part way, listing what was and was not written.
 *
 * Resolves with the planned changes. A rule an agent cannot enforce is reported in `refused`, and
 * nothing is written.
 */
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
    ompAgentDir,
    ompGlobal,
  } = options;

  // Build agent filter from --with/--without
  const agentFilter = buildAgentFilter(withList, withoutList);

  // 1. Collect files by walking up, plus OMP's global config, which OMP reads beneath every project
  const files = collectFiles(cwd, up);
  const ompGlobalPath = ompGlobalConfigPath(ompAgentDir);
  if (
    (!agentFilter || agentFilter.has("omp")) &&
    existsSync(ompGlobalPath) &&
    !files.some((f) => f.path === ompGlobalPath)
  ) {
    files.push({ agent: "omp", path: ompGlobalPath, local: false });
  }

  const note = makeNote(options.warned);
  const projectRoot = resolve(cwd);
  const writePaths = new Set<string>([
    join(projectRoot, ".agents", "permissions.json"),
    ...Object.values(AGENT_FILES).flatMap((def) =>
      def.extract === undefined
        ? []
        : nativeFileNames(def).map((name) => join(projectRoot, name)),
    ),
    ...(ompGlobal ? [ompGlobalPath] : []),
  ]);

  // OpenCode loads every one of its config file names and applies them in order, so a second file
  // keeps contributing rules that sync, which edits only the preferred one, does not touch.
  for (const [agent, def] of Object.entries(AGENT_FILES)) {
    for (const dir of new Set(files.map((f) => dirname(f.path)))) {
      const present = nativeFileNames(def).filter((name) =>
        files.some((f) => f.agent === agent && f.path === join(dir, name)),
      );
      if (present.length > 1) {
        note(
          join(dir, present[0] ?? def.name),
          `${present.map((n) => join(dir, n)).join(" and ")} both exist; the first takes precedence and is the one sync edits, but the agent applies both`,
        );
      }
    }
  }

  if (files.length === 0) {
    process.stderr.write(
      "No permission configs found. Create .agents/permissions.json to get started.\n",
    );
    return { changes: [], applied: false, refused: [], aborted: false };
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
    const decoded = await readAndDecode(file, {
      agentFilter,
      writePaths,
      note,
    });
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
    return { changes: [], applied: false, refused: [], aborted: false };
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
  const { targets, refused } = computeWriteTargets(
    cwd,
    merged,
    sources,
    agentFilter,
    create,
    CODECS,
    ompGlobal ? ompGlobalPath : undefined,
  );

  if (refused.length > 0) {
    for (const error of refused)
      process.stderr.write(`error: ${error.message}\n`);
    process.stderr.write(
      "Nothing was written. Fix the rules above, or leave the agent out with --without.\n",
    );
    return { changes: [], applied: false, refused, aborted: false };
  }

  if (targets.length === 0) {
    process.stderr.write("No write targets.\n");
    return { changes: [], applied: false, refused: [], aborted: false };
  }

  // 5. Build changes
  const changes: FileChange[] = [];
  for (const target of targets) {
    const current = target.exists ? await readIfPresent(target.path) : null;

    let proposed: string;
    try {
      proposed = target.render(current);
    } catch (error) {
      // An agent's own message about its file (invalid YAML, a non-mapping top level) is a refusal.
      if (error instanceof SyncRefusedError || !(error instanceof Error)) {
        throw error;
      }
      throw new SyncRefusedError(target.path, "invalid-format", error.message, {
        cause: error,
      });
    }

    // Skip if content is semantically identical
    if (current !== null) {
      if (sameData(target.agent, current, proposed)) continue;
    } else if (proposed === "") {
      continue;
    }

    changes.push({
      path: target.path,
      agent: target.agent,
      kind: target.exists ? "update" : "create",
      current,
      proposed,
    });
  }

  if (changes.length === 0) {
    process.stderr.write("Already in sync — no changes needed.\n");
    return { changes: [], applied: true, refused: [], aborted: false };
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
    return { changes, applied: false, refused: [], aborted: false };
  }

  if (!yes) {
    process.stderr.write("Apply these changes? [y/N] ");
    const answer = await readLine();
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      process.stderr.write("Aborted.\n");
      return { changes, applied: false, refused: [], aborted: true };
    }
  }

  // 8. Write files. Every file is checked first, so one that changed since it was read stops the
  // sync before the first write; each write checks again as it replaces its file. A failure part
  // way through is reported with exactly what was written and what was not; nothing is rolled back.
  for (const change of changes) {
    await assertUnchanged(change.path, change.current);
  }
  const written: string[] = [];
  for (const change of changes) {
    try {
      // Backup if requested and file exists. OMP's config is hand-written and holds much more than
      // permissions, so it is always backed up.
      if ((backup || change.agent === "omp") && change.current !== null) {
        await writeBackup(change.path, change.current);
      }
      await writeFileAtomic(change.path, change.proposed, change.current);
    } catch (error) {
      throw new SyncWriteError(
        error,
        written,
        changes.map((c) => c.path).filter((p) => !written.includes(p)),
      );
    }
    written.push(change.path);
  }

  process.stderr.write(`Applied ${String(changes.length)} change(s).\n`);
  return { changes, applied: true, refused: [], aborted: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One line from standard input; the end of input is an empty answer, which declines. */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.setEncoding("utf-8");
    const finish = (answer: string): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("close", onEnd);
      resolve(answer);
    };
    const onData = (data: string): void => {
      finish(data.trim());
    };
    const onEnd = (): void => {
      finish("");
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
  });
}

/**
 * Build an agent filter from --with and --without lists. Returns undefined when no filtering is
 * needed (all agents included). --with and --without are mutually exclusive.
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
    // Set<string> so the filter can compare plain key strings against the excluded names.
    const excluded = new Set<string>(withoutList);
    return new Set(allAgents.filter((a) => !excluded.has(a)));
  }

  return undefined;
}
