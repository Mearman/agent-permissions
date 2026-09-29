/**
 * MCP server for agent-perms: a sync daemon, and optionally a permission-prompt tool.
 *
 * Sits as a background MCP server that keeps native agent config files bidirectionally synced with
 * `.agents/permissions.json`. By default it exposes no tools. With the permission-prompt mode on it
 * exposes one, `permission_prompt`, which answers a host's permission prompts from the policy (see
 * `prompt-tool.ts`).
 *
 * Modes (configured via `.agents/permissions.json` → `sync.mode`):
 *
 * - `"sync"`: One-shot sync at startup, then stay alive (passive).
 * - `"watch"`: Continuous sync via filesystem watching.
 * - `false` / absent: No sync (just a passive MCP server).
 *
 * The project directory is the server's working directory.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { AgentPermissionPolicy } from "./schema.ts";
import {
  defaultOmpAgentDir,
  parseJson,
  validatePolicy,
} from "./agent-files.ts";
import { loadPolicy } from "./loader.ts";
import {
  createPermissionPrompt,
  PermissionPromptRequest,
  promptToolContent,
  type AskHandler,
} from "./prompt-tool.ts";
import { sync } from "./sync.ts";

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

interface SyncConfig {
  mode: "sync" | "watch" | false;
  backup: boolean;
}

function resolveSyncConfig(
  policy: AgentPermissionPolicy | undefined,
): SyncConfig {
  if (policy === undefined) return { mode: false, backup: false };
  const s = policy.sync;
  return {
    mode: s?.mode ?? false,
    backup: s?.backup ?? false,
  };
}

async function loadRootPolicy(
  rootDir: string,
): Promise<AgentPermissionPolicy | undefined> {
  const filePath = join(rootDir, ".agents", "permissions.json");
  if (!existsSync(filePath)) return undefined;
  const content = await readFile(filePath, "utf-8").catch(() => undefined);
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
    ompAgentDir: defaultOmpAgentDir(),
    ompGlobal: false,
  });
}

function startWatcher(cwd: string, config: SyncConfig): void {
  if (config.mode !== "watch") return;

  const watchedDirs = new Set<string>();

  // Watch .agents/ and native config locations
  const watchPaths = [
    join(cwd, ".agents"),
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
          filename === "permissions.json" ||
          filename === "permissions.local.json" ||
          filename === "settings.json" ||
          filename === "settings.local.json" ||
          filename === "opencode.json" ||
          filename === ".crush.json" ||
          filename === "codex.toml"
        ) {
          void performSync(cwd, config);
        }
      });
      watcher.on("error", () => {
        // Silently ignore watch errors
      });
    } catch {
      // fs.watch may throw on some platforms
    }
  }

  process.stderr.write(
    `[agent-perms-mcp] Watching ${cwd} for config changes (mode: watch)\n`,
  );
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

export interface McpServerOptions {
  /**
   * Expose the `permission_prompt` tool. `onAsk` settles calls the policy asks about; without it
   * they are denied.
   */
  permissionPrompt?: { onAsk?: AskHandler };
}

/** The permission-prompt tool's name; a host refers to it as `mcp__<server name>__permission_prompt`. */
const PERMISSION_PROMPT_TOOL = "permission_prompt";

/**
 * Build the server for a project root without connecting it. It exposes no tools unless the
 * permission-prompt mode is on.
 */
export function createMcpServer(
  root: string,
  options: McpServerOptions,
): McpServer {
  const server = new McpServer(
    { name: "agent-perms", version: "0.1.0" },
    {
      instructions:
        "agent-perms sync daemon. Keeps native agent config files " +
        "bidirectionally synced with .agents/permissions.json. " +
        "Configured via sync.mode in .agents/permissions.json.",
    },
  );

  const { permissionPrompt } = options;
  if (permissionPrompt !== undefined) {
    const answer = createPermissionPrompt({
      loadPolicy: () => loadPolicy({ cwd: root }),
      root,
      ...(permissionPrompt.onAsk === undefined
        ? {}
        : { onAsk: permissionPrompt.onAsk }),
    });
    server.registerTool(
      PERMISSION_PROMPT_TOOL,
      {
        description:
          "Answers a permission prompt from the agent-perms policy: allow or deny the tool call described by tool_name and input.",
        inputSchema: PermissionPromptRequest.shape,
      },
      async (request, extra) =>
        promptToolContent(await answer(request, extra.signal)),
    );
  }

  return server;
}

/**
 * Serve on stdio from the current directory, running the sync the policy's `sync.mode` asks for.
 */
export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const projectRoot = resolve(process.cwd());
  const server = createMcpServer(projectRoot, options);

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[agent-perms-mcp] Started (root: ${projectRoot}, permission prompt: ${options.permissionPrompt === undefined ? "off" : "on"})\n`,
  );

  // Load config and perform initial sync
  const policy = await loadRootPolicy(projectRoot);
  const config = resolveSyncConfig(policy);

  process.stderr.write(
    `[agent-perms-mcp] Config: mode=${String(config.mode)}, backup=${String(config.backup)}\n`,
  );

  if (config.mode === "sync" || config.mode === "watch") {
    await performSync(projectRoot, config);
    process.stderr.write("[agent-perms-mcp] Initial sync complete\n");
  }

  if (config.mode === "watch") {
    startWatcher(projectRoot, config);
  }

  // Keep alive — MCP server handles the event loop
}
