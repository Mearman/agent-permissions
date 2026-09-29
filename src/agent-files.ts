/**
 * Agent config file resolution — shared between CLI and sync.
 *
 * Maps format names to default file paths, walks directories to find configs, and provides
 * read/write helpers for the convert/validate/check/sync pipeline.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  Document,
  isMap,
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
} from "yaml";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { type AgentId, type OmpEncoded } from "./compat/codecs.ts";
import { isRecord } from "./guards.ts";
import { type Format } from "./api.ts";

// ---------------------------------------------------------------------------
// File mapping
// ---------------------------------------------------------------------------

/** Per-format config file info. */
export interface AgentFileDef {
  /** Relative path to the main config file. */
  name: string;
  /** Relative path to the local override file (read-only, never written). */
  localName?: string;
  /**
   * Extract the permissions payload from a parsed native config. Returns undefined if the config
   * doesn't contain a permissions block.
   */
  extract?: (raw: unknown) => unknown;
  /** Wrap encoded permissions back into the native config structure. */
  wrap?: (encoded: unknown) => unknown;
}

/** Default config file for each agent format, relative to a project root. */
export const AGENT_FILES: Record<AgentId | "canonical", AgentFileDef> = {
  canonical: {
    name: ".agents/permissions.json",
    localName: ".agents/permissions.local.json",
    extract: (raw) => raw,
    wrap: (encoded) => encoded,
  },
  "claude-code": {
    name: ".claude/settings.json",
    localName: ".claude/settings.local.json",
    extract: (raw) => {
      if (!isRecord(raw) || !("permissions" in raw)) return undefined;
      return raw.permissions;
    },
    wrap: (encoded) => ({ permissions: encoded }),
  },
  codex: { name: "codex.toml" }, // TOML — read only if pre-parsed
  opencode: {
    name: "opencode.json",
    extract: (raw) => {
      if (!isRecord(raw) || !("permission" in raw)) return undefined;
      return raw.permission;
    },
    wrap: (encoded) => ({ permission: encoded }),
  },
  crush: { name: ".crush.json" }, // Crush has no standard config file
  // OMP's project config. Its global copy lives in the agent directory (see ompGlobalConfigPath),
  // and sync writes either one only through editOmpConfig, so `wrap` is not used.
  omp: {
    name: ".omp/config.yml",
    extract: (raw) => (isRecord(raw) ? raw : undefined),
  },
  kiro: {
    name: ".kiro/permissions.json",
    extract: (raw) => raw,
    wrap: (encoded) => encoded,
  },
};

/** Get the default file name for a format. */
export function defaultFileName(format: Format): string {
  return AGENT_FILES[format].name;
}

// ---------------------------------------------------------------------------
// Walk-up resolution
// ---------------------------------------------------------------------------

/**
 * Walk up from a starting directory, looking for a format's default file. Returns the first
 * existing file found, or the default path in `startDir`.
 */
export function findDefaultFile(format: Format, startDir: string): string {
  const fileName = defaultFileName(format);
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, fileName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(resolve(startDir), fileName);
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Discriminated union for operations that can fail. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Create a successful result. */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Create a failed result. */
export function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

/** Read stdin as a string. */
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    // The stream's iterator types its chunks as `any`; instanceof narrows without an assertion. Buffer is a Uint8Array subclass, so binary chunks take the first branch.
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    } else if (typeof chunk === "string") {
      chunks.push(new TextEncoder().encode(chunk));
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Read from a file path, or stdin if undefined. */
export async function readInput(path: string | undefined): Promise<string> {
  if (path === undefined) return readStdin();
  return readFile(path, "utf-8");
}

/** Parse a JSON string. Returns a Result instead of throwing. */
export function parseJson(raw: string, source: string): Result<unknown> {
  try {
    return ok(JSON.parse(raw));
  } catch {
    return fail(`${source}: invalid JSON`);
  }
}

/**
 * Parse an agent's native config. OMP's is YAML; every other agent's is JSON. YAML is a superset of
 * JSON, so an OMP config written as JSON parses too.
 */
export function parseAgentFile(
  format: Format | undefined,
  raw: string,
  source: string,
): Result<unknown> {
  if (format !== "omp" && !/\.ya?ml$/u.test(source)) {
    return parseJson(raw, source);
  }
  try {
    const value: unknown = parseYaml(raw);
    return ok(value);
  } catch {
    return fail(`${source}: invalid YAML`);
  }
}

/** A native config as file content: YAML for OMP, JSON for everything else. */
export function stringifyAgentFile(
  format: Format,
  value: unknown,
  compact: boolean,
): string {
  if (format === "omp") return stringifyYaml(value);
  return JSON.stringify(value, null, compact ? undefined : 2) + "\n";
}

/**
 * OMP's agent directory, which holds its global config: `PI_CODING_AGENT_DIR` when set, as OMP
 * reads it, else `~/.omp/agent`.
 */
export function ompAgentDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  return env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent");
}

/** OMP's agent directory for this process. */
export function defaultOmpAgentDir(): string {
  return ompAgentDir(process.env, homedir());
}

/**
 * OMP's global config in an agent directory, chosen as OMP chooses it: the first of `config.yml`
 * and `config.yaml` that exists, else `config.yml`.
 */
export function ompGlobalConfigPath(agentDir: string): string {
  const yaml = join(agentDir, "config.yaml");
  const yml = join(agentDir, "config.yml");
  return !existsSync(yml) && existsSync(yaml) ? yaml : yml;
}

/**
 * An OMP config with `bash.patterns` and `tools.approvalMode` set from an encoded policy and
 * everything else, comments included, left as it was. `bash.patterns` is replaced by the encoded
 * list, or removed when there is none; `tools.approvalMode` is set only when the encoding has one,
 * so a mode the policy leaves to OMP stays as the user wrote it.
 *
 * @param current The file's content, or `null` for a new file.
 * @throws Error when `current` is not valid YAML or its top level is not a mapping, rather than
 *   replacing a file it could not read.
 */
export function editOmpConfig(
  current: string | null,
  encoded: OmpEncoded,
): string {
  const doc = current === null ? new Document({}) : parseDocument(current);
  const [error] = doc.errors;
  if (error !== undefined) {
    throw new Error(`invalid YAML: ${error.message}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error("an OMP config must be a mapping at the top level");
  }
  if (encoded.bash === undefined) {
    if (doc.hasIn(["bash", "patterns"])) doc.deleteIn(["bash", "patterns"]);
  } else {
    doc.setIn(["bash", "patterns"], doc.createNode(encoded.bash.patterns));
  }
  if (encoded.tools !== undefined) {
    doc.setIn(["tools", "approvalMode"], encoded.tools.approvalMode);
  }
  return doc.toString();
}

/** Write JSON to a file, creating parent directories as needed. */
export async function writeJsonFile(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// ---------------------------------------------------------------------------
// Decode / validate helpers
// ---------------------------------------------------------------------------

import { AgentPermissionPolicy } from "./schema.ts";
import { CODECS } from "./compat/codecs.ts";

/** Validation error for a single field. */
export interface ValidationError {
  /** Dot-separated path to the invalid field, or "(root)". */
  path: string;
  /** Human-readable error message. */
  message: string;
}

/** Detailed validation result with structured errors. */
export type ValidateResult =
  | { ok: true; value: AgentPermissionPolicy }
  | { ok: false; error: string; errors: ValidationError[] };

/** Validate parsed JSON against the canonical policy schema. */
export function validatePolicy(json: unknown): ValidateResult {
  const result = AgentPermissionPolicy.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const errors: ValidationError[] = result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
  return {
    ok: false,
    error: `validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join(", ")}`,
    errors,
  };
}

/**
 * Decode native agent config → canonical policy. Extracts the permissions payload using the agent's
 * extract(), decodes via codec, then validates against the canonical schema.
 */
export function decodeNative(format: AgentId, raw: unknown): ValidateResult {
  const def = AGENT_FILES[format];
  if (def.extract === undefined) {
    return {
      ok: false,
      error: `${format}: no extract defined for this format`,
      errors: [],
    };
  }

  const payload = def.extract(raw);
  if (payload === undefined || payload === null) {
    return {
      ok: false,
      error: `${format}: no permissions payload found in config`,
      errors: [],
    };
  }

  const codec = CODECS[format];
  let decoded: unknown;
  try {
    // The payload genuinely is unknown here (an extract() output), while each zod codec's decode is typed for its own native input — a payload of the wrong shape throws inside decode and lands in the catch below.
    // @ts-expect-error unknown payload passed to a native-typed decode; invalid shapes throw and are handled by the catch
    decoded = codec.decode(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `${format} decode failed: ${message}`,
      errors: [],
    };
  }

  return validatePolicy(decoded);
}
