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
}

/** Default config file for each agent format, relative to a project root. */
export const AGENT_FILES: Record<AgentId | "canonical", AgentFileDef> = {
  canonical: {
    name: ".agents/permissions.json",
    localName: ".agents/permissions.local.json",
  },
  "claude-code": {
    name: ".claude/settings.json",
    localName: ".claude/settings.local.json",
  },
  codex: { name: "codex.toml" },
  opencode: { name: "opencode.json" },
  crush: { name: ".crush.json" },
  kiro: { name: ".kiro/permissions.json" },
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

/** Parse JSON, throwing on failure with a contextual message. */
export function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${source}: invalid JSON`);
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
