/** Helpers for the tests of sync's handling of a user's native config files. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type SyncOptions } from "../sync.ts";

const dirs: string[] = [];

/** Remove every directory `project` made; call it from `after`. */
export async function cleanup(): Promise<void> {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
}

/** A project holding the canonical policy and nothing else. */
export async function project(
  canonical: Record<string, unknown>,
): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "native-config-"));
  dirs.push(cwd);
  await mkdir(join(cwd, ".agents"), { recursive: true });
  await writeFile(
    join(cwd, ".agents", "permissions.json"),
    JSON.stringify(canonical),
  );
  return cwd;
}

export function options(
  cwd: string,
  overrides: Partial<SyncOptions> = {},
): SyncOptions {
  return {
    cwd,
    up: 0,
    with: [],
    without: [],
    yes: true,
    dryRun: false,
    create: false,
    verbose: false,
    backup: false,
    ompAgentDir: join(tmpdir(), "no-omp-agent"),
    ompGlobal: false,
    ...overrides,
  };
}

/** Write a file under a project, creating its directory, and return its path. */
export async function put(
  cwd: string,
  path: string,
  text: string,
): Promise<string> {
  const full = join(cwd, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, text);
  return full;
}

export async function json(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
  assert.ok(typeof parsed === "object" && parsed !== null);
  return Object.fromEntries(Object.entries(parsed));
}

export const denyRm = { tool: "Bash", pattern: "rm:*", tier: "deny" } as const;
export const allowRead = { tool: "Read", tier: "allow" } as const;
