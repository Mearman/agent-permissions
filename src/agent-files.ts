/**
 * Agent config file resolution — shared between CLI and sync.
 *
 * Maps format names to default file paths, walks directories to find configs,
 * and provides read/write helpers for the convert/validate/check/sync pipeline.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { type AgentId } from "./compat/codecs.ts";
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
   * Extract the permissions payload from a parsed native config.
   * Returns undefined if the config doesn't contain a permissions block.
   */
  extract?: (raw: unknown) => unknown;
  /**
   * Wrap encoded permissions back into the native config structure.
   */
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
      if (typeof raw !== "object" || raw === null) return undefined;
      if (!("permissions" in raw)) return undefined;
      return (raw as Record<string, unknown>).permissions;
    },
    wrap: (encoded) => ({ permissions: encoded }),
  },
  codex: { name: "codex.toml" }, // TOML — read only if pre-parsed
  opencode: {
    name: "opencode.json",
    extract: (raw) => {
      if (typeof raw !== "object" || raw === null) return undefined;
      if (!("permission" in raw)) return undefined;
      return (raw as Record<string, unknown>).permission;
    },
    wrap: (encoded) => ({ permission: encoded }),
  },
  crush: { name: ".crush.json" }, // Crush has no standard config file
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
 * Walk up from a starting directory, looking for a format's default file.
 * Returns the first existing file found, or the default path in `startDir`.
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
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
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
 * Decode native agent config → canonical policy.
 * Extracts the permissions payload using the agent's extract(),
 * decodes via codec, then validates against the canonical schema.
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
    decoded = (codec as { decode: (input: unknown) => unknown }).decode(
      payload,
    );
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
