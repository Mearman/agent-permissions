import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { computeWriteTargets, sync, type SyncOptions } from "../sync.ts";
import { UnsupportedCapabilityError } from "../compat/unsupported.ts";

/** Narrow unknown to a record for JSON.parse result access — unavoidable object→Record boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

void describe("sync", () => {
  const dirs: string[] = [];

  // Clean up after all tests
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  void it("detects and merges Claude Code settings into canonical", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Create Claude Code settings
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(git status)", "Read"],
          deny: ["Bash(sudo:*)"],
        },
      }),
    );

    const result = await sync({
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
    });

    assert.equal(result.applied, true);
    assert.equal(result.changes.length, 2); // canonical created + claude-code write-back

    // Check canonical was created
    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    assert.ok(Array.isArray(parsed.rules));

    // Should have deny rule for sudo
    const denyRules = (parsed.rules as Record<string, unknown>[]).filter(
      (r) => r.tier === "deny",
    );
    assert.ok(denyRules.length > 0);
  });

  void it("detects and merges OpenCode config into canonical", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    await writeFile(
      join(cwd, "opencode.json"),
      JSON.stringify({
        permission: {
          bash: { "git *": "allow", "rm *": "deny" },
          read: "allow",
        },
      }),
    );

    const result = await sync({
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
    });

    assert.equal(result.applied, true);

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    assert.ok(Array.isArray(parsed.rules));
  });

  void it("merges multiple sources with deny-first priority", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Claude Code has allow for git status
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(git status)"],
        },
      }),
    );

    // OpenCode has deny for git status
    await writeFile(
      join(cwd, "opencode.json"),
      JSON.stringify({
        permission: {
          bash: { "git status": "deny" },
        },
      }),
    );

    const result = await sync({
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
    });

    assert.equal(result.applied, true);

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    const rules = parsed.rules as Record<string, unknown>[];

    // Deny should win over allow for same tool+pattern
    const gitStatusRules = rules.filter(
      (r) => r.pattern === "git status" && r.tool === "Bash",
    );
    assert.equal(gitStatusRules.length, 1);
    const rule = gitStatusRules[0];
    assert.ok(rule !== undefined);
    assert.equal(rule.tier, "deny");
  });

  void it("respects --from filter to read only from specific agents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(git status)"],
        },
      }),
    );

    await writeFile(
      join(cwd, "opencode.json"),
      JSON.stringify({
        permission: {
          bash: { "rm *": "deny" },
        },
      }),
    );

    const result = await sync({
      cwd,
      up: 0,
      with: ["claude-code"],
      without: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
      ompAgentDir: join(tmpdir(), "no-omp-agent"),
      ompGlobal: false,
    });

    assert.equal(result.applied, true);

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    const rules = parsed.rules as Record<string, unknown>[];

    // Should only have Claude Code rules, not OpenCode
    const denyRules = rules.filter((r) => r.tier === "deny");
    assert.equal(denyRules.length, 0);
  });

  void it("dry-run does not write files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Read"],
        },
      }),
    );

    const result = await sync({
      cwd,
      up: 0,
      with: [],
      without: [],
      yes: false,
      dryRun: true,
      create: false,
      verbose: false,
      backup: false,
      ompAgentDir: join(tmpdir(), "no-omp-agent"),
      ompGlobal: false,
    });

    assert.equal(result.applied, false);
    assert.ok(result.changes.length > 0);

    // Canonical should NOT exist
    try {
      await readFile(join(cwd, ".agents", "permissions.json"), "utf-8");
      assert.fail("File should not exist");
    } catch (e) {
      assert.ok((e as { code: string }).code === "ENOENT");
    }
  });

  void it("respects --up 0 to only read from cwd", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sync-test-"));
    const child = join(parent, "project");
    await mkdir(child, { recursive: true });
    dirs.push(parent);

    // Parent has Claude Code settings
    await mkdir(join(parent, ".claude"), { recursive: true });
    await writeFile(
      join(parent, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(npm run build:*)"],
        },
      }),
    );

    // Child has its own settings
    await mkdir(join(child, ".claude"), { recursive: true });
    await writeFile(
      join(child, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Read"],
        },
      }),
    );

    const result = await sync({
      cwd: child,
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
    });

    assert.equal(result.applied, true);

    const canonical = await readFile(
      join(child, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    const rules = parsed.rules as Record<string, unknown>[];

    // Should only have child's Read rule, not parent's npm rule
    const npmRules = rules.filter(
      (r) => typeof r.pattern === "string" && r.pattern.includes("npm"),
    );
    assert.equal(npmRules.length, 0);
  });

  void it("walks up to parent when --up > 0", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sync-test-"));
    const child = join(parent, "project");
    await mkdir(child, { recursive: true });
    dirs.push(parent);

    // Parent has Claude Code settings
    await mkdir(join(parent, ".claude"), { recursive: true });
    await writeFile(
      join(parent, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(npm run build:*)"],
        },
      }),
    );

    const result = await sync({
      cwd: child,
      up: 1,
      with: [],
      without: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
      ompAgentDir: join(tmpdir(), "no-omp-agent"),
      ompGlobal: false,
    });

    assert.equal(result.applied, true);

    const canonical = await readFile(
      join(child, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    const rules = parsed.rules as Record<string, unknown>[];

    // Should include parent's npm rule
    const npmRules = rules.filter(
      (r) => typeof r.pattern === "string" && r.pattern.includes("npm"),
    );
    assert.equal(npmRules.length, 1);
  });

  void it("--create creates missing native config files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Only canonical exists
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify({
        rules: [
          { tool: "Read", tier: "allow" },
          { tool: "Bash", pattern: "sudo:*", tier: "deny" },
        ],
      }),
    );

    const result = await sync({
      cwd,
      up: 0,
      with: ["claude-code"],
      without: [],
      yes: true,
      dryRun: false,
      create: true,
      verbose: false,
      backup: false,
      ompAgentDir: join(tmpdir(), "no-omp-agent"),
      ompGlobal: false,
    });

    assert.equal(result.applied, true);

    // Claude Code settings should have been created
    const cc = await readFile(join(cwd, ".claude", "settings.json"), "utf-8");
    const parsed: unknown = JSON.parse(cc);
    assert.ok(isRecord(parsed));
    assert.ok(isRecord(parsed.permissions));
  });

  void it("reports no changes when already in sync", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    const schemaUrl =
      "https://github.com/ExaDev/agent-permissions/releases/latest/download/agent-permissions.schema.json";
    const policy = {
      $schema: schemaUrl,
      rules: [{ tool: "Read", tier: "allow" }],
    };

    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify(policy, null, 2) + "\n",
    );

    const result = await sync({
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
    });

    assert.equal(result.applied, true);
    assert.equal(result.changes.length, 0);
  });

  void it("skips codex and crush (no file support)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Create codex.toml (won't be read — TOML)
    await writeFile(join(cwd, "codex.toml"), "[approval]\npolicy = 'never'");

    const result = await sync({
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
    });

    // Should still work, just skip codex
    assert.equal(result.applied, false);
    assert.equal(result.changes.length, 0);
  });

  void it("most restrictive defaultMode wins in merge", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Claude Code has autonomous (bypassPermissions)
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          defaultMode: "bypassPermissions",
          allow: ["Read"],
        },
      }),
    );

    // OpenCode has restricted (deny)
    await writeFile(
      join(cwd, "opencode.json"),
      JSON.stringify({
        permission: "deny",
      }),
    );

    await sync({
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
    });

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    // restricted (3) > autonomous (1)
    assert.equal(parsed.defaultMode, "restricted");
  });

  // -----------------------------------------------------------------------
  // Branch coverage: local files, additionalDirectories, verbose, --without
  // -----------------------------------------------------------------------

  void it("detects local override files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Main canonical
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify({ rules: [{ tool: "Read", tier: "allow" }] }),
    );

    // Local override
    await writeFile(
      join(cwd, ".agents", "permissions.local.json"),
      JSON.stringify({ rules: [{ tool: "Bash", tier: "deny" }] }),
    );

    // Also test Claude local override detection
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Read"] },
      }),
    );
    await writeFile(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { deny: ["Bash(rm:*)"] },
      }),
    );

    const result = await sync({
      cwd,
      up: 0,
      with: [],
      without: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: true,
      backup: false,
      ompAgentDir: join(tmpdir(), "no-omp-agent"),
      ompGlobal: false,
    });

    assert.equal(result.applied, true);

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    const rules = parsed.rules as Record<string, unknown>[];

    // Should have deny from local override
    const denyRules = rules.filter((r) => r.tier === "deny");
    assert.ok(denyRules.length > 0);
  });

  void it("merges additionalDirectories from permissions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Read"],
          additionalDirectories: ["/tmp/workspace", "/home/user/projects"],
        },
      }),
    );

    await sync({
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
    });

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    assert.ok(isRecord(parsed.permissions));
    assert.ok(Array.isArray(parsed.permissions.additionalDirectories));
    assert.equal(parsed.permissions.additionalDirectories.length, 2);
  });

  void it("--without excludes specific agents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(git status)"] },
      }),
    );

    await writeFile(
      join(cwd, "opencode.json"),
      JSON.stringify({
        permission: { bash: { "rm *": "deny" } },
      }),
    );

    await sync({
      cwd,
      up: 0,
      with: [],
      without: ["claude-code"],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
      ompAgentDir: join(tmpdir(), "no-omp-agent"),
      ompGlobal: false,
    });

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    const rules = parsed.rules as Record<string, unknown>[];

    // Should only have OpenCode deny rule, not Claude Code allow
    const allowRules = rules.filter(
      (r) => r.tier === "allow" && r.pattern === "git status",
    );
    assert.equal(allowRules.length, 0);
  });

  void it("handles unreadable files gracefully", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Create a file with invalid JSON
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(join(cwd, ".claude", "settings.json"), "not valid json");

    // Also a valid canonical file
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify({ rules: [{ tool: "Read", tier: "allow" }] }),
    );

    const result = await sync({
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
    });

    // Should still succeed — invalid file is skipped
    assert.equal(result.applied, true);
  });

  void it("produces verbose output with rule provenance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Read"] },
      }),
    );

    // Capture stderr output by running with verbose
    const originalWrite = process.stderr.write.bind(process.stderr);
    const chunks: string[] = [];
    process.stderr.write = (data: string) => {
      chunks.push(data);
      return true;
    };

    try {
      await sync({
        cwd,
        up: 0,
        with: [],
        without: [],
        yes: true,
        dryRun: false,
        create: false,
        verbose: true,
        backup: false,
        ompAgentDir: join(tmpdir(), "no-omp-agent"),
        ompGlobal: false,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    const output = chunks.join("");
    assert.match(output, /Detected config/);
    assert.match(output, /Merged/);
  });

  void it("merges agent-specific fields (sandbox, network, delegation)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Canonical with sandbox and network
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify({
        rules: [{ tool: "Read", tier: "allow" }],
        sandbox: { mode: "workspace-write" },
        network: { enabled: false },
      }),
    );

    await sync({
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
    });

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    assert.ok(isRecord(parsed.sandbox));
    assert.equal(parsed.sandbox.mode, "workspace-write");
    assert.ok(isRecord(parsed.network));
    assert.equal(parsed.network.enabled, false);
  });

  void it("merges profiles and activeProfile", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify({
        rules: [{ tool: "Read", tier: "allow" }],
        profiles: {
          strict: { deny: ["Bash"], allow: ["Read"] },
        },
        activeProfile: "strict",
      }),
    );

    await sync({
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
    });

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    assert.ok(isRecord(parsed.profiles));
    assert.equal(parsed.activeProfile, "strict");
  });

  void it("merges env and delegation fields", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify({
        rules: [{ tool: "Read", tier: "allow" }],
        delegation: { maxDepth: 2 },
        env: { NODE_ENV: "production" },
      }),
    );

    await sync({
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
    });

    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(canonical);
    assert.ok(isRecord(parsed));
    assert.ok(isRecord(parsed.delegation));
    assert.ok(isRecord(parsed.env));
  });
});

void describe("sync of roles and delegation across layers", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  async function syncedFromInner(
    outer: object,
    inner: object,
  ): Promise<unknown> {
    const root = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(root);
    const cwd = join(root, "project");
    await mkdir(join(root, ".agents"), { recursive: true });
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(root, ".agents", "permissions.json"),
      JSON.stringify(outer),
    );
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify(inner),
    );
    await sync({
      cwd,
      up: 1,
      with: [],
      without: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
      ompAgentDir: join(tmpdir(), "no-omp-agent"),
      ompGlobal: false,
    });
    return JSON.parse(
      await readFile(join(cwd, ".agents", "permissions.json"), "utf-8"),
    ) as unknown;
  }

  void it("keeps the shallowest maxDepth and every nonDelegable rule", async () => {
    const written = await syncedFromInner(
      { delegation: { maxDepth: 1, nonDelegable: ["Bash(sudo:*)"] } },
      { delegation: { maxDepth: 3, nonDelegable: ["Write(./.agents/**)"] } },
    );
    assert.ok(isRecord(written) && isRecord(written.delegation));
    assert.equal(written.delegation.maxDepth, 1);
    const barred: unknown = written.delegation.nonDelegable;
    assert.ok(Array.isArray(barred));
    assert.deepEqual(barred.map(String).sort(), [
      "Bash(sudo:*)",
      "Write(./.agents/**)",
    ]);
  });

  void it("keeps roles as roles, joined across layers, rather than expanding them", async () => {
    const written = await syncedFromInner(
      { roles: { maintainer: { allow: ["Bash(git push:*)"] } } },
      {
        roles: {
          maintainer: { ask: ["Bash(npm publish:*)"] },
          contractor: { deny: ["Bash(git push:*)"] },
        },
      },
    );
    assert.ok(isRecord(written) && isRecord(written.roles));
    assert.deepEqual(written.roles, {
      maintainer: { allow: ["Bash(git push:*)"], ask: ["Bash(npm publish:*)"] },
      contractor: { deny: ["Bash(git push:*)"] },
    });
    assert.equal(written.rules, undefined);
  });
});

void describe("computeWriteTargets", () => {
  type Agent = "claude-code" | "codex" | "kiro" | "opencode" | "crush" | "omp";
  const rule = { tool: "Bash", pattern: "rm:*", tier: "deny" } as const;

  /** An encoder table where each agent encodes to an empty config unless told to throw. */
  function encoders(
    refusals: Partial<Record<Agent, () => never>>,
  ): Record<Agent, { encode: () => unknown }> {
    const encoderFor = (agent: Agent): { encode: () => unknown } => ({
      encode: (): unknown => {
        refusals[agent]?.();
        return { permissions: {} };
      },
    });
    return {
      "claude-code": encoderFor("claude-code"),
      codex: encoderFor("codex"),
      kiro: encoderFor("kiro"),
      opencode: encoderFor("opencode"),
      crush: encoderFor("crush"),
      omp: encoderFor("omp"),
    };
  }

  void it("reports an agent whose codec refuses the policy instead of skipping it", () => {
    const refusal = new UnsupportedCapabilityError("opencode", [
      { rule, reason: "no equivalent" },
    ]);
    const { targets, refused } = computeWriteTargets(
      tmpdir(),
      { rules: [rule] },
      [],
      undefined,
      true,
      encoders({
        opencode: () => {
          throw refusal;
        },
      }),
    );
    assert.deepEqual(refused, [refusal]);
    assert.equal(
      targets.some((t) => t.agent === "opencode"),
      false,
    );
  });

  void it("lets an unexpected error from a codec through", () => {
    assert.throws(
      () =>
        computeWriteTargets(
          tmpdir(),
          { rules: [rule] },
          [],
          undefined,
          true,
          encoders({
            kiro: () => {
              throw new TypeError("a bug in the codec");
            },
          }),
        ),
      TypeError,
    );
  });
});

void describe("sync of Oh My Pi's config", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  const projectConfig = [
    "# project settings",
    "model: fast # the quick one",
    "bash:",
    "  patterns:",
    "    - match: git *",
    "      approval: allow",
    "",
  ].join("\n");

  /** A project directory and an agent directory standing in for the home directory's, both temporary. */
  async function fixture(): Promise<{ cwd: string; agentDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "sync-omp-"));
    dirs.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "home", ".omp", "agent");
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    return { cwd, agentDir };
  }

  function options(
    cwd: string,
    agentDir: string,
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
      ompAgentDir: agentDir,
      ompGlobal: false,
      ...overrides,
    };
  }

  async function writeCanonical(
    cwd: string,
    policy: Record<string, unknown>,
  ): Promise<void> {
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify(policy),
    );
  }

  async function readYaml(path: string): Promise<unknown> {
    return parseYaml(await readFile(path, "utf-8"));
  }

  void it("writes the merged bash.patterns and approval mode into the project file, keeping everything else", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, {
      defaultMode: "standard",
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    });
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);

    const result = await sync(options(cwd, agentDir));

    assert.equal(result.applied, true);
    const written = await readFile(join(cwd, ".omp", "config.yml"), "utf-8");
    assert.match(written, /# project settings/);
    assert.match(written, /model: fast # the quick one/);
    assert.deepEqual(parseYaml(written), {
      model: "fast",
      bash: {
        patterns: [
          { match: "rm", approval: "deny" },
          { match: "rm *", approval: "deny" },
          { match: "git", approval: "allow" },
          { match: "git *", approval: "allow" },
        ],
      },
      tools: { approvalMode: "always-ask" },
    });
  });

  void it("backs the file up before writing it", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, {
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    });
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);

    await sync(options(cwd, agentDir));

    assert.equal(
      await readFile(join(cwd, ".omp", "config.yml.bak"), "utf-8"),
      projectConfig,
    );
  });

  void it("leaves a stricter approval mode in place for an autonomous policy", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, { defaultMode: "autonomous" });
    await mkdir(join(cwd, ".omp"));
    await writeFile(
      join(cwd, ".omp", "config.yml"),
      "tools:\n  approvalMode: always-ask\n",
    );

    await sync(options(cwd, agentDir));

    assert.deepEqual(await readYaml(join(cwd, ".omp", "config.yml")), {
      tools: { approvalMode: "always-ask" },
    });
  });

  void it("does not create the project file unless asked", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, {
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    });

    await sync(options(cwd, agentDir));
    assert.equal(existsSync(join(cwd, ".omp", "config.yml")), false);

    await sync(options(cwd, agentDir, { create: true }));
    assert.deepEqual(await readYaml(join(cwd, ".omp", "config.yml")), {
      bash: {
        patterns: [
          { match: "rm", approval: "deny" },
          { match: "rm *", approval: "deny" },
        ],
      },
    });
  });

  void it("reads the global file into the merge but writes it only when asked", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, {});
    const globalConfig =
      "# global\nbash:\n  patterns:\n    - match: sudo *\n      approval: deny\n";
    await writeFile(join(agentDir, "config.yml"), globalConfig);
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);

    await sync(options(cwd, agentDir));

    // The project list replaces the global one in Oh My Pi, so it carries the global deny
    const project = await readYaml(join(cwd, ".omp", "config.yml"));
    assert.ok(isRecord(project) && isRecord(project.bash));
    assert.deepEqual(project.bash.patterns, [
      { match: "sudo", approval: "deny" },
      { match: "sudo *", approval: "deny" },
      { match: "git", approval: "allow" },
      { match: "git *", approval: "allow" },
    ]);
    assert.equal(
      await readFile(join(agentDir, "config.yml"), "utf-8"),
      globalConfig,
    );

    await sync(options(cwd, agentDir, { ompGlobal: true }));

    const global = await readFile(join(agentDir, "config.yml"), "utf-8");
    assert.match(global, /# global/);
    assert.deepEqual(parseYaml(global), { bash: project.bash });
    assert.equal(
      await readFile(join(agentDir, "config.yml.bak"), "utf-8"),
      globalConfig,
    );
  });

  void it("writes nothing when the Oh My Pi codec refuses the policy", async () => {
    const { cwd, agentDir } = await fixture();
    const canonical = {
      rules: [{ tool: "Write", pattern: "./secrets", tier: "deny" }],
    };
    await writeCanonical(cwd, canonical);
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);

    const result = await sync(options(cwd, agentDir));

    assert.equal(result.applied, false);
    assert.deepEqual(
      result.refused.map((e) => e.agent),
      ["omp"],
    );
    assert.equal(
      await readFile(join(cwd, ".omp", "config.yml"), "utf-8"),
      projectConfig,
    );
    assert.equal(
      await readFile(join(cwd, ".agents", "permissions.json"), "utf-8"),
      JSON.stringify(canonical),
    );
  });

  void it("fails on an Oh My Pi file it cannot read instead of overwriting it", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, {});
    await mkdir(join(cwd, ".omp"));
    const unreadable =
      "bash:\n  patterns:\n    - match: rm *\n      approval: forbid\n";
    await writeFile(join(cwd, ".omp", "config.yml"), unreadable);

    await assert.rejects(sync(options(cwd, agentDir)), /config\.yml/);
    assert.equal(
      await readFile(join(cwd, ".omp", "config.yml"), "utf-8"),
      unreadable,
    );
  });

  void it("leaves Oh My Pi alone when it is left out", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, {
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    });
    await writeFile(
      join(agentDir, "config.yml"),
      "bash:\n  patterns:\n    - match: sudo *\n      approval: deny\n",
    );
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);

    await sync(options(cwd, agentDir, { without: ["omp"] }));

    assert.equal(
      await readFile(join(cwd, ".omp", "config.yml"), "utf-8"),
      projectConfig,
    );
    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    assert.doesNotMatch(canonical, /sudo/);
  });

  void it("writes nothing on a dry run", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, {
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    });
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);

    const result = await sync(options(cwd, agentDir, { dryRun: true }));

    assert.ok(result.changes.some((c) => c.agent === "omp"));
    assert.equal(
      await readFile(join(cwd, ".omp", "config.yml"), "utf-8"),
      projectConfig,
    );
  });

  void it("leaves the file alone once it is in step", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, {
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    });
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);

    await sync(options(cwd, agentDir));
    const written = await readFile(join(cwd, ".omp", "config.yml"), "utf-8");
    const second = await sync(options(cwd, agentDir));

    assert.equal(
      second.changes.some((c) => c.agent === "omp"),
      false,
    );
    assert.equal(
      await readFile(join(cwd, ".omp", "config.yml"), "utf-8"),
      written,
    );
    assert.equal(existsSync(join(cwd, ".omp", "config.yml.bak")), true);
  });
});

void describe("sync of native JSON configs that hold other settings", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  async function project(canonical: Record<string, unknown>): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), "sync-keep-"));
    dirs.push(cwd);
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify(canonical),
    );
    return cwd;
  }

  function options(
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

  async function writeNative(
    cwd: string,
    path: string,
    content: string,
  ): Promise<void> {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), content);
  }

  async function readJson(path: string): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    assert.ok(isRecord(parsed));
    return parsed;
  }

  const denyRm = { tool: "Bash", pattern: "rm:*", tier: "deny" } as const;
  const hooks = {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" }] }],
  };

  void it("keeps every other key of .claude/settings.json, in order", async () => {
    const cwd = await project({ rules: [denyRm] });
    await writeNative(
      cwd,
      ".claude/settings.json",
      JSON.stringify({
        model: "opus",
        permissions: { allow: ["Read"] },
        env: { A: "1" },
        hooks,
      }),
    );

    await sync(options(cwd));

    const settings = await readJson(join(cwd, ".claude", "settings.json"));
    assert.deepEqual(Object.keys(settings), [
      "model",
      "permissions",
      "env",
      "hooks",
    ]);
    assert.equal(settings.model, "opus");
    assert.deepEqual(settings.env, { A: "1" });
    assert.deepEqual(settings.hooks, hooks);
    assert.deepEqual(settings.permissions, {
      allow: ["Read"],
      deny: ["Bash(rm:*)"],
      ask: [],
    });
  });

  void it("replaces the permissions key rather than merging into it", async () => {
    const cwd = await project({
      rules: [{ tool: "Bash", pattern: "git:*", tier: "deny" }],
    });
    await writeNative(
      cwd,
      ".claude/settings.json",
      JSON.stringify({
        permissions: { allow: ["Bash(git:*)"], additionalDirectories: ["/x"] },
        model: "opus",
      }),
    );

    await sync(options(cwd));

    const settings = await readJson(join(cwd, ".claude", "settings.json"));
    assert.deepEqual(settings.permissions, {
      allow: [],
      deny: ["Bash(git:*)"],
      ask: [],
      additionalDirectories: ["/x"],
    });
    assert.equal(settings.model, "opus");
  });

  void it("adds permissions after the existing keys when the file has none", async () => {
    const cwd = await project({ rules: [denyRm] });
    await writeNative(
      cwd,
      ".claude/settings.json",
      JSON.stringify({ model: "opus" }),
    );

    await sync(options(cwd, { create: true }));

    const settings = await readJson(join(cwd, ".claude", "settings.json"));
    assert.deepEqual(Object.keys(settings), ["model", "permissions"]);
  });

  void it("keeps every other key of opencode.json", async () => {
    const cwd = await project({ rules: [denyRm] });
    await writeNative(
      cwd,
      "opencode.json",
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "anthropic/claude",
        permission: { read: "allow" },
        mcp: { docs: { type: "remote", url: "https://example.com/mcp" } },
      }),
    );

    await sync(options(cwd));

    const config = await readJson(join(cwd, "opencode.json"));
    assert.deepEqual(Object.keys(config), [
      "$schema",
      "model",
      "permission",
      "mcp",
    ]);
    assert.equal(config.model, "anthropic/claude");
    assert.deepEqual(config.mcp, {
      docs: { type: "remote", url: "https://example.com/mcp" },
    });
    assert.deepEqual(config.permission, {
      read: "allow",
      bash: { "rm *": "deny" },
    });
  });

  void it("keeps the other keys of .kiro/permissions.json and the settings it merges into", async () => {
    const cwd = await project({ rules: [denyRm] });
    await writeNative(
      cwd,
      ".kiro/permissions.json",
      JSON.stringify({
        name: "project agent",
        allowedTools: ["read"],
        toolsSettings: { web_fetch: { trusted: ["\\A.*\\z"] } },
        prompt: "be careful",
      }),
    );

    await sync(options(cwd));

    const config = await readJson(join(cwd, ".kiro", "permissions.json"));
    assert.equal(config.name, "project agent");
    assert.equal(config.prompt, "be careful");
    assert.deepEqual(config.allowedTools, ["read"]);
    assert.deepEqual(config.toolsSettings, {
      web_fetch: { trusted: ["\\A.*\\z"] },
      shell: { deniedCommands: ["\\Arm:*\\z"] },
    });
  });

  void it("creates a file that is absent holding only the permissions", async () => {
    const cwd = await project({ rules: [denyRm] });

    await sync(options(cwd, { create: true }));

    const settings = await readJson(join(cwd, ".claude", "settings.json"));
    assert.deepEqual(Object.keys(settings), ["permissions"]);
  });

  void it("reports no change when the file already holds the permissions and other keys", async () => {
    const cwd = await project({ rules: [denyRm] });
    await writeNative(
      cwd,
      ".claude/settings.json",
      JSON.stringify({
        permissions: { allow: [], deny: ["Bash(rm:*)"], ask: [] },
        model: "opus",
      }),
    );

    const first = await sync(options(cwd));
    const second = await sync(options(cwd));

    assert.equal(
      first.changes.some((c) => c.agent === "claude-code"),
      false,
    );
    assert.deepEqual(second.changes, []);
  });

  void it("shows the kept keys in a dry run and writes nothing", async () => {
    const cwd = await project({ rules: [denyRm] });
    const original = JSON.stringify({
      model: "opus",
      permissions: { allow: ["Read"] },
    });
    await writeNative(cwd, ".claude/settings.json", original);

    const result = await sync(options(cwd, { dryRun: true }));

    const change = result.changes.find((c) => c.agent === "claude-code");
    assert.ok(change);
    assert.match(change.proposed, /"model":\s*"opus"/u);
    assert.equal(
      await readFile(join(cwd, ".claude", "settings.json"), "utf-8"),
      original,
    );
  });

  void it("backs up the file as it was when asked", async () => {
    const cwd = await project({ rules: [denyRm] });
    const original = JSON.stringify({
      model: "opus",
      permissions: { allow: ["Read"] },
    });
    await writeNative(cwd, ".claude/settings.json", original);

    await sync(options(cwd, { backup: true }));

    assert.equal(
      await readFile(join(cwd, ".claude", "settings.json.bak"), "utf-8"),
      original,
    );
  });

  for (const [label, content] of [
    ["invalid JSON", "{ not json"],
    ["a top level that is not an object", "[]"],
  ] as const) {
    void it(`refuses an existing file holding ${label} and writes nothing`, async () => {
      const cwd = await project({ rules: [denyRm] });
      await writeNative(cwd, ".claude/settings.json", content);

      await assert.rejects(
        sync(options(cwd, { create: true })),
        /settings\.json/u,
      );

      assert.equal(
        await readFile(join(cwd, ".claude", "settings.json"), "utf-8"),
        content,
      );
      assert.equal(
        existsSync(join(cwd, ".claude", "settings.json.bak")),
        false,
      );
      assert.equal(existsSync(join(cwd, "opencode.json")), false);
    });
  }
});
