/**
 * Tests for the permission policy loader.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadPolicy } from "../loader.ts";

/**
 * Create an isolated temp directory for a test.
 */
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

  void describe("native source loading", () => {
    void it("loads Claude Code settings", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
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

      const policy = await loadPolicy({
        cwd,
        nativeSources: ["claude-code"],
      });
      assert.ok(policy.rules, "rules must exist");
      assert.ok(policy.rules.length > 0, "must have rules");
    });

    void it("loads OpenCode config", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
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

      const policy = await loadPolicy({
        cwd,
        nativeSources: ["opencode"],
      });
      assert.ok(policy.rules, "rules must exist");
      const denyRules = policy.rules.filter((r) => r.tier === "deny");
      assert.ok(denyRules.length > 0, "must have deny rules from edit:deny");
    });

    void it("ignores unknown native source", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      const policy = await loadPolicy({
        cwd,
        // Testing resilience to unknown source strings
        nativeSources: ["unknown" as "claude-code"],
      });
      assert.equal(policy.defaultMode, "standard");
    });

    void it("codex returns undefined (TOML not supported)", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      const policy = await loadPolicy({
        cwd,
        nativeSources: ["codex"],
      });
      assert.equal(policy.defaultMode, "standard");
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
});
