/**
 * MCP server for agent-perms — sync daemon.
 *
 * Sits as a background MCP server that keeps native agent config files bidirectionally synced with
 * `.agents/permissions.json`. Exposes no tools.
 *
 * Modes (configured via `.agents/permissions.json` → `sync.mode`):
 *
 * - `"sync"`: One-shot sync at startup, then stay alive (passive).
 * - `"watch"`: Continuous sync via filesystem watching.
 * - `false` / absent: No sync (just a passive MCP server).
 *
 * The project directory is discovered via `roots/list` from the MCP client, or falls back to
 * `process.cwd()`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { readFile } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { AgentPermissionPolicy } from './schema.ts';
import { parseJson, validatePolicy } from './agent-files.ts';
import { sync } from './sync.ts';

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

interface SyncConfig {
  mode: 'sync' | 'watch' | false;
  backup: boolean;
}

function resolveSyncConfig(policy: AgentPermissionPolicy | undefined): SyncConfig {
  if (policy === undefined) return { mode: false, backup: false };
  const s = policy.sync;
  return {
    mode: s?.mode ?? false,
    backup: s?.backup ?? false,
  };
}

async function loadRootPolicy(rootDir: string): Promise<AgentPermissionPolicy | undefined> {
  const filePath = join(rootDir, '.agents', 'permissions.json');
  if (!existsSync(filePath)) return undefined;
  const content = await readFile(filePath, 'utf-8').catch(() => undefined);
  if (content === undefined) return undefined;
  const parsed = parseJson(content, filePath);
  if (!parsed.ok) return undefined;
  const validated = validatePolicy(parsed.value);
  if (!validated.ok) return undefined;
  return validated.value;
}

// ---------------------------------------------------------------------------
// Sync operations
// ---------------------------------------------------------------------------

async function performSync(cwd: string, config: SyncConfig): Promise<void> {
  if (config.mode === false) return;

  await sync({
    cwd,
    up: Infinity,
    with: [],
    without: [],
    yes: true,
    dryRun: false,
    create: true,
    verbose: false,
    backup: config.backup,
  });
}

function startWatcher(cwd: string, config: SyncConfig): void {
  if (config.mode !== 'watch') return;

  const watchedDirs = new Set<string>();

  // Watch .agents/ and native config locations
  const watchPaths = [
    join(cwd, '.agents'),
    cwd, // native configs live at project root
  ];

  for (const dir of watchPaths) {
    if (!existsSync(dir)) continue;
    if (watchedDirs.has(dir)) continue;
    watchedDirs.add(dir);

    try {
      const watcher = watch(dir, { recursive: false }, (_event, filename) => {
        if (filename === null) return;
        // Only react to relevant config files
        if (
          filename === 'permissions.json' ||
          filename === 'permissions.local.json' ||
          filename === 'settings.json' ||
          filename === 'settings.local.json' ||
          filename === 'opencode.json' ||
          filename === '.crush.json' ||
          filename === 'codex.toml'
        ) {
          void performSync(cwd, config);
        }
      });
      watcher.on('error', () => {
        // Silently ignore watch errors
      });
    } catch {
      // fs.watch may throw on some platforms
    }
  }

  process.stderr.write(`[agent-perms-mcp] Watching ${cwd} for config changes (mode: watch)\n`);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'agent-perms', version: '0.1.0' },
    {
      instructions:
        'agent-perms sync daemon. Keeps native agent config files ' +
        'bidirectionally synced with .agents/permissions.json. ' +
        'Configured via sync.mode in .agents/permissions.json.',
    }
  );

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // After connection, use cwd as project root
  const projectRoot = resolve(process.cwd());

  process.stderr.write(`[agent-perms-mcp] Started (root: ${projectRoot})\n`);

  // Load config and perform initial sync
  const policy = await loadRootPolicy(projectRoot);
  const config = resolveSyncConfig(policy);

  process.stderr.write(
    `[agent-perms-mcp] Config: mode=${String(config.mode)}, backup=${String(config.backup)}\n`
  );

  if (config.mode === 'sync' || config.mode === 'watch') {
    await performSync(projectRoot, config);
    process.stderr.write('[agent-perms-mcp] Initial sync complete\n');
  }

  if (config.mode === 'watch') {
    startWatcher(projectRoot, config);
  }

  // Keep alive — MCP server handles the event loop
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[agent-perms-mcp] Fatal: ${message}\n`);
  process.exit(1);
});
