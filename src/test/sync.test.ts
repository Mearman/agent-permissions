import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sync } from "../sync.ts";

/** Narrow unknown to a record for JSON.parse result access — unavoidable object→Record boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("sync", () => {
  const dirs: string[] = [];

  // Clean up after all tests
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  it("detects and merges Claude Code settings into canonical", async () => {
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
      from: [],
      to: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
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

  it("detects and merges OpenCode config into canonical", async () => {
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
      from: [],
      to: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
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

  it("merges multiple sources with deny-first priority", async () => {
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
      from: [],
      to: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
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

  it("respects --from filter to read only from specific agents", async () => {
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
      from: ["claude-code"],
      to: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
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

  it("dry-run does not write files", async () => {
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
      from: [],
      to: [],
      yes: false,
      dryRun: true,
      create: false,
      verbose: false,
      backup: false,
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

  it("respects --up 0 to only read from cwd", async () => {
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
      from: [],
      to: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
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

  it("walks up to parent when --up > 0", async () => {
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
      from: [],
      to: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
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

  it("--create creates missing native config files", async () => {
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
      from: [],
      to: ["claude-code"],
      yes: true,
      dryRun: false,
      create: true,
      verbose: false,
      backup: false,
    });

    assert.equal(result.applied, true);

    // Claude Code settings should have been created
    const cc = await readFile(join(cwd, ".claude", "settings.json"), "utf-8");
    const parsed: unknown = JSON.parse(cc);
    assert.ok(isRecord(parsed));
    assert.ok(isRecord(parsed.permissions));
  });

  it("reports no changes when already in sync", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    const policy = {
      rules: [{ tool: "Read", tier: "allow" }],
    };

    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify(policy) + "\n",
    );

    const result = await sync({
      cwd,
      up: 0,
      from: [],
      to: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
    });

    assert.equal(result.applied, true);
    assert.equal(result.changes.length, 0);
  });

  it("skips codex and crush (no file support)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Create codex.toml (won't be read — TOML)
    await writeFile(join(cwd, "codex.toml"), "[approval]\npolicy = 'never'");

    const result = await sync({
      cwd,
      up: 0,
      from: [],
      to: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
    });

    // Should still work, just skip codex
    assert.equal(result.applied, false);
    assert.equal(result.changes.length, 0);
  });

  it("most restrictive defaultMode wins in merge", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sync-test-"));
    dirs.push(cwd);

    // Claude Code has autonomous (dontAsk)
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        permissions: {
          defaultMode: "dontAsk",
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
      from: [],
      to: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
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
});
