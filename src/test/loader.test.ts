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

describe("loadPolicy", () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  describe("canonical loading", () => {
    it("returns standard mode when no files exist", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      const policy = await loadPolicy({ cwd });
      assert.equal(policy.defaultMode, "standard");
      assert.equal(policy.permissions, undefined);
    });

    it("loads .agents/permissions.json", async () => {
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
      assert.ok(policy.permissions, "permissions must exist");
      assert.deepEqual(policy.permissions.deny, ["Bash(rm -rf *)"]);
      assert.deepEqual(policy.permissions.allow, ["Bash(*)"]);
    });

    it("returns undefined for invalid JSON in canonical file", async () => {
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

    it("returns undefined for schema-invalid canonical file", async () => {
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

  describe("layer merging", () => {
    it("local overrides committed defaultMode", async () => {
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
      assert.ok(policy.permissions, "permissions must exist");
      assert.deepEqual(policy.permissions.allow, ["Bash(ls)"]);
    });

    it("merges deny rules from both layers", async () => {
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
      assert.ok(policy.permissions, "permissions must exist");
      assert.deepEqual(policy.permissions.deny, [
        "Bash(rm *)",
        "Bash(curl domain:evil.com)",
      ]);
    });

    it("merges all three tiers across layers", async () => {
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
      assert.ok(policy.permissions, "permissions must exist");
      assert.deepEqual(policy.permissions.deny, ["Bash(rm *)"]);
      assert.deepEqual(policy.permissions.ask, ["Bash(curl *)"]);
      assert.deepEqual(policy.permissions.allow, [
        "Bash(git *)",
        "Bash(npm *)",
      ]);
    });
  });

  describe("native source loading", () => {
    it("loads Claude Code settings", async () => {
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
      assert.ok(policy.permissions, "permissions must exist");
      const hasAllow =
        policy.permissions.allow !== undefined &&
        policy.permissions.allow.length > 0;
      const hasDeny =
        policy.permissions.deny !== undefined &&
        policy.permissions.deny.length > 0;
      assert.ok(hasAllow || hasDeny, "must have allow or deny rules");
    });

    it("loads OpenCode config", async () => {
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
      assert.ok(policy.permissions, "permissions must exist");
      assert.deepEqual(policy.permissions.deny, ["Edit"]);
    });

    it("ignores unknown native source", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      const policy = await loadPolicy({
        cwd,
        // Testing resilience to unknown source strings
        nativeSources: ["unknown" as "claude-code"],
      });
      assert.equal(policy.defaultMode, "standard");
    });

    it("codex returns undefined (TOML not supported)", async () => {
      const cwd = await isolate();
      dirs.push(cwd);
      const policy = await loadPolicy({
        cwd,
        nativeSources: ["codex"],
      });
      assert.equal(policy.defaultMode, "standard");
    });
  });

  describe("mode mapping", () => {
    it("maps bypassPermissions to autonomous", async () => {
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

    it("maps plan to restricted", async () => {
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
