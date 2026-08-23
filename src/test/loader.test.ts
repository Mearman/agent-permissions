/** Tests for the permission policy loader. */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadPolicy } from "../loader.ts";

/** Create an isolated temp directory for a test. */
async function isolate(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-perms-test-"));
}

void describe("loadPolicy", () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  void describe("canonical loading", () => {
    void it("returns standard mode when no files exist", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      const policy = await loadPolicy({ cwd });
      assert.equal(policy.defaultMode, "standard");
      assert.equal(policy.rules, undefined);
    });

    void it("loads .agents/permissions.json", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          defaultMode: "autonomous",
          permissions: {
            deny: ["Bash(rm -rf *)"],
            allow: ["Bash(*)"],
          },
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.equal(policy.defaultMode, "autonomous");
      assert.ok(policy.rules, "rules must exist");
      assert.equal(policy.rules.length, 2);
      assert.deepStrictEqual(policy.rules[0], {
        tool: "Bash",
        pattern: "rm -rf *",
        tier: "deny",
      });
      assert.deepStrictEqual(policy.rules[1], {
        tool: "Bash",
        tier: "allow",
      });
    });

    void it("returns undefined for invalid JSON in canonical file", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        "not valid json{{{",
      );

      const policy = await loadPolicy({ cwd });
      assert.equal(policy.defaultMode, "standard");
    });

    void it("returns undefined for schema-invalid canonical file", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          defaultMode: "not-a-real-mode",
          permissions: {
            deny: [12345], // not a string
          },
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.equal(policy.defaultMode, "standard");
    });
  });

  void describe("layer merging", () => {
    void it("local overrides committed defaultMode", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          defaultMode: "standard",
          permissions: { allow: ["Bash(ls)"] },
        }),
      );
      await writeFile(
        join(cwd, ".agents", "permissions.local.json"),
        JSON.stringify({
          defaultMode: "autonomous",
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.equal(policy.defaultMode, "autonomous");
      assert.ok(policy.rules, "rules must exist");
      assert.equal(policy.rules.length, 1);
      assert.deepStrictEqual(policy.rules[0], {
        tool: "Bash",
        pattern: "ls",
        tier: "allow",
      });
    });

    void it("merges deny rules from both layers", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          permissions: { deny: ["Bash(rm *)"] },
        }),
      );
      await writeFile(
        join(cwd, ".agents", "permissions.local.json"),
        JSON.stringify({
          permissions: { deny: ["Bash(curl domain:evil.com)"] },
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.ok(policy.rules, "rules must exist");
      const rules = policy.rules;
      assert.ok(rules, "rules narrowed");
      const denyRules = rules.filter((r) => r.tier === "deny");
      assert.equal(denyRules.length, 2);
      const [first, second] = denyRules;
      assert.equal(first?.pattern, "rm *");
      assert.equal(second?.pattern, "curl domain:evil.com");
    });

    void it("merges all three tiers across layers", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          permissions: {
            deny: ["Bash(rm *)"],
            allow: ["Bash(git *)"],
          },
        }),
      );
      await writeFile(
        join(cwd, ".agents", "permissions.local.json"),
        JSON.stringify({
          permissions: {
            ask: ["Bash(curl *)"],
            allow: ["Bash(npm *)"],
          },
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.ok(policy.rules, "rules must exist");
      const denyRules = policy.rules.filter((r) => r.tier === "deny");
      const askRules = policy.rules.filter((r) => r.tier === "ask");
      const allowRules = policy.rules.filter((r) => r.tier === "allow");
      assert.equal(denyRules.length, 1);
      assert.equal(askRules.length, 1);
      assert.equal(allowRules.length, 2);
    });
  });

  void describe("native source loading via with/without/up", () => {
    void it("loads Claude Code settings when with includes claude-code", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Bash(git *)"],
            deny: ["Bash(rm -rf *)"],
          },
        }),
      );
      // Canonical file must exist and declare it wants claude-code
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          with: ["claude-code"],
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.ok(policy.rules, "rules must exist");
      assert.ok(policy.rules.length > 0, "must have rules");
    });

    void it("ignores Claude Code settings when with does not include it", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Bash(git *)"],
            deny: ["Bash(rm -rf *)"],
          },
        }),
      );
      // No with — default is canonical only
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          defaultMode: "standard",
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.equal(policy.rules, undefined);
    });

    void it("loads OpenCode config when with includes opencode", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, "opencode.json"),
        JSON.stringify({
          permission: {
            bash: "allow",
            edit: "deny",
            read: "allow",
          },
        }),
      );
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          with: ["opencode"],
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.ok(policy.rules, "rules must exist");
      const denyRules = policy.rules.filter((r) => r.tier === "deny");
      assert.ok(denyRules.length > 0, "must have deny rules from edit:deny");
    });

    void it("excludes agent when without lists it", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Bash(git *)"],
          },
        }),
      );
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          without: ["claude-code"],
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.equal(policy.rules, undefined, "claude-code should be excluded");
    });

    void it("skips codex (TOML not supported)", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(join(cwd, "codex.toml"), "# codex config\n");
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          with: ["codex"],
        }),
      );

      const policy = await loadPolicy({ cwd });
      // codex has no extract(), so no native rules loaded
      assert.equal(policy.rules, undefined);
    });
  });

  void describe("walk-up discovery", () => {
    void it("walks up to parent directories by default", async () => {
      const parent = await isolate();
      dirs.push(parent);
      await mkdir(join(parent, ".agents"), { recursive: true });
      await writeFile(
        join(parent, ".agents", "permissions.json"),
        JSON.stringify({
          defaultMode: "autonomous",
          permissions: { allow: ["Read"] },
        }),
      );

      const child = join(parent, "subproject");
      await mkdir(child, { recursive: true });
      dirs.push(child);

      const policy = await loadPolicy({ cwd: child });
      assert.equal(policy.defaultMode, "autonomous");
      assert.ok(policy.rules, "rules must exist");
    });

    void it("respects up: 0 from outermost canonical file", async () => {
      const parent = await isolate();
      dirs.push(parent);
      await mkdir(join(parent, ".agents"), { recursive: true });
      await writeFile(
        join(parent, ".agents", "permissions.json"),
        JSON.stringify({
          up: 0,
          defaultMode: "autonomous",
        }),
      );

      const child = join(parent, "subproject");
      await mkdir(child, { recursive: true });
      dirs.push(child);

      const policy = await loadPolicy({ cwd: child });
      // up: 0 means don't walk up — but the canonical file IS at parent,
      // and pass 1 discovers it with Infinity to find all canonical files.
      // The resolved up is 0, so pass 2 only checks cwd (child).
      // No canonical file at child, so standard mode.
      assert.equal(policy.defaultMode, "standard");
    });

    void it("respects up: N limiting parent traversal", async () => {
      const root = await isolate();
      dirs.push(root);

      // Create: root/.agents/permissions.json (up: 0)
      await mkdir(join(root, ".agents"), { recursive: true });
      await writeFile(
        join(root, ".agents", "permissions.json"),
        JSON.stringify({
          up: 0,
          defaultMode: "autonomous",
        }),
      );

      // root/a/b/c — 3 levels deep
      const deep = join(root, "a", "b", "c");
      await mkdir(deep, { recursive: true });
      dirs.push(join(root, "a"));
      dirs.push(join(root, "a", "b"));
      dirs.push(deep);

      const policy = await loadPolicy({ cwd: deep });
      // up: 0 means only check cwd, which has no canonical file
      assert.equal(policy.defaultMode, "standard");
    });

    void it("child overrides parent defaultMode", async () => {
      const parent = await isolate();
      dirs.push(parent);
      await mkdir(join(parent, ".agents"), { recursive: true });
      await writeFile(
        join(parent, ".agents", "permissions.json"),
        JSON.stringify({
          defaultMode: "autonomous",
          permissions: { deny: ["Bash(rm *)"] },
        }),
      );

      const child = join(parent, "subproject");
      await mkdir(join(child, ".agents"), { recursive: true });
      await writeFile(
        join(child, ".agents", "permissions.json"),
        JSON.stringify({
          defaultMode: "restricted",
        }),
      );
      dirs.push(child);

      const policy = await loadPolicy({ cwd: child });
      // Child's restricted overrides parent's autonomous (last-defined wins)
      assert.equal(policy.defaultMode, "restricted");
      // But parent's deny rules still merged in
      assert.ok(policy.rules, "rules must exist");
      assert.equal(policy.rules.length, 1);
      assert.equal(policy.rules[0]?.tier, "deny");
    });

    void it("merges native configs from parent and child directories", async () => {
      const parent = await isolate();
      dirs.push(parent);
      await mkdir(join(parent, ".agents"), { recursive: true });
      await mkdir(join(parent, ".claude"), { recursive: true });
      await writeFile(
        join(parent, ".agents", "permissions.json"),
        JSON.stringify({
          with: ["claude-code"],
        }),
      );
      await writeFile(
        join(parent, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            deny: ["Bash(rm *)"],
          },
        }),
      );

      const child = join(parent, "subproject");
      await mkdir(join(child, ".claude"), { recursive: true });
      await mkdir(join(child, ".agents"), { recursive: true });
      await writeFile(
        join(child, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Bash(git *)"],
          },
        }),
      );
      dirs.push(child);

      const policy = await loadPolicy({ cwd: child });
      assert.ok(policy.rules, "rules must exist");
      // Both parent's deny and child's claude-code allow should be present
      const denyRules = policy.rules.filter((r) => r.tier === "deny");
      const allowRules = policy.rules.filter((r) => r.tier === "allow");
      assert.ok(denyRules.length > 0, "parent deny rules");
      assert.ok(allowRules.length > 0, "child allow rules");
    });
  });

  void describe("mode mapping", () => {
    void it("maps bypassPermissions to autonomous", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          defaultMode: "bypassPermissions",
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.equal(policy.defaultMode, "autonomous");
    });

    void it("maps plan to restricted", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          defaultMode: "plan",
        }),
      );

      const policy = await loadPolicy({ cwd });
      assert.equal(policy.defaultMode, "restricted");
    });
  });

  void describe("with/without mutual exclusivity", () => {
    void it("schema rejects both with and withut", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          with: ["claude-code"],
          without: ["opencode"],
        }),
      );

      const policy = await loadPolicy({ cwd });
      // Schema validation rejects the file, falls back to standard
      assert.equal(policy.defaultMode, "standard");
    });
  });
});
