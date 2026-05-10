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
 *   - permissions.deny: merged (union) — deny from ANY source is final
 *   - permissions.ask: merged (union)
 *   - permissions.allow: merged (union)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { agentPermissionPolicy, type AgentPermissionPolicy } from "./schema.ts";
import { claudeCodeCodec, opencodeCodec } from "./compat/codecs.ts";

import type { PermissionPolicy } from "./evaluate.ts";

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
  const raw = await readJson(filePath);
  if (!raw) return undefined;
  const result = agentPermissionPolicy.safeParse(raw);
  if (!result.success) return undefined;
  return result.data;
}

async function loadNative(
  cwd: string,
  source: string,
): Promise<AgentPermissionPolicy | undefined> {
  switch (source) {
    case "claude-code":
      return loadClaudeCode(cwd);
    case "codex":
      // Codex uses TOML — consumer should pre-parse and pass the object.
      return undefined;
    case "opencode":
      return loadOpenCode(cwd);
    default:
      return undefined;
  }
}

async function loadClaudeCode(
  cwd: string,
): Promise<AgentPermissionPolicy | undefined> {
  const settings = await readJson(join(cwd, ".claude", "settings.json"));
  if (typeof settings !== "object" || settings === null) return undefined;
  if (!("permissions" in settings)) return undefined;
  const perms = (settings as Record<string, unknown>).permissions;
  if (perms === undefined || perms === null) return undefined;
  try {
    return claudeCodeCodec.decode(perms);
  } catch {
    return undefined;
  }
}

async function loadOpenCode(
  cwd: string,
): Promise<AgentPermissionPolicy | undefined> {
  const config = await readJson(join(cwd, "opencode.json"));
  if (typeof config !== "object" || config === null) return undefined;
  const obj = config as Record<string, unknown>;
  if (!("permission" in obj)) return undefined;
  const perm = obj.permission;
  if (perm === undefined || perm === null) return undefined;
  try {
    return opencodeCodec.decode(perm);
  } catch {
    return undefined;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    const content = await readFile(filePath, "utf-8");
    const data: unknown = JSON.parse(content);
    return data;
  } catch {
    return undefined;
  }
}

function mergeLayers(layers: AgentPermissionPolicy[]): PermissionPolicy {
  if (layers.length === 0) {
    return { defaultMode: "standard" };
  }

  let mode: PermissionPolicy["defaultMode"] = "standard";
  const deny: string[] = [];
  const ask: string[] = [];
  const allow: string[] = [];

  for (const layer of layers) {
    if (layer.defaultMode) {
      mode = mapMode(layer.defaultMode);
    }
    if (layer.permissions) {
      if (layer.permissions.deny) deny.push(...layer.permissions.deny);
      if (layer.permissions.ask) ask.push(...layer.permissions.ask);
      if (layer.permissions.allow) allow.push(...layer.permissions.allow);
    }
  }

  return {
    defaultMode: mode,
    permissions: {
      ...(deny.length > 0 ? { deny } : {}),
      ...(ask.length > 0 ? { ask } : {}),
      ...(allow.length > 0 ? { allow } : {}),
    },
  };
}

function mapMode(mode: string): PermissionPolicy["defaultMode"] {
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
