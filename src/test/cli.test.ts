/**
 * Tests for the agent-perms CLI.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dirname, "..", "..", "dist", "cli.mjs");

/** Narrow unknown to a record for JSON.parse result access — unavoidable object→Record boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function run(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], (err, stdout, stderr) => {
      const exitCode =
        err !== null && typeof err.code === "number" ? err.code : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

describe("CLI", () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  describe("validate", () => {
    it("validates a correct policy file", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ defaultMode: "standard" }),
      );
      const result = await run(["validate", join(cwd, "policy.json")]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /valid/);
    });

    it("rejects an invalid policy file", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "bad.json"),
        JSON.stringify({ defaultMode: "yolo" }),
      );
      const result = await run(["validate", join(cwd, "bad.json")]);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /validation errors/);
    });

    it("rejects invalid JSON", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(join(cwd, "broken.json"), "not json{{{");
      const result = await run(["validate", join(cwd, "broken.json")]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /invalid JSON/);
    });
  });

  describe("check", () => {
    it("allows a matching rule", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
        }),
      );
      const result = await run([
        "check",
        "--tool",
        "bash",
        "--input",
        "git status",
        join(cwd, "policy.json"),
      ]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /allow/);
    });

    it("denies a matching deny rule", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          rules: [{ tool: "Bash", pattern: "sudo:*", tier: "deny" }],
        }),
      );
      const result = await run([
        "check",
        "--tool",
        "bash",
        "--input",
        "sudo rm -rf /",
        join(cwd, "policy.json"),
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stdout, /deny/);
    });
  });

  describe("convert", () => {
    it("converts claude-code to canonical", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "settings.json"),
        JSON.stringify({
          allow: ["Bash(git status)", "Read"],
          deny: ["Bash(sudo:*)"],
        }),
      );
      const result = await run([
        "convert",
        "--from",
        "claude-code",
        "--to",
        "canonical",
        join(cwd, "settings.json"),
      ]);
      assert.equal(result.exitCode, 0);
      const parsed: unknown = JSON.parse(result.stdout);
      assert.ok(isRecord(parsed));
      const rules = parsed.rules;
      assert.ok(Array.isArray(rules));
      assert.equal(rules.length, 3);
      const first: unknown = rules[0];
      assert.ok(isRecord(first));
      // deny rules come first
      assert.equal(first.tool, "Bash");
      assert.equal(first.pattern, "sudo:*");
      assert.equal(first.tier, "deny");
    });

    it("converts canonical to crush", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          permissions: { allow: ["Read", "Bash", "Grep"] },
        }),
      );
      const result = await run([
        "convert",
        "--from",
        "canonical",
        "--to",
        "crush",
        join(cwd, "policy.json"),
      ]);
      assert.equal(result.exitCode, 0);
      const parsed: unknown = JSON.parse(result.stdout);
      assert.ok(isRecord(parsed));
      assert.deepEqual(parsed.allowed_tools, ["view", "bash", "grep"]);
    });

    it("rejects unknown --from agent", async () => {
      const result = await run([
        "convert",
        "--from",
        "phantom",
        "--to",
        "canonical",
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /unknown --from agent/);
    });

    it("rejects missing --from", async () => {
      const result = await run(["convert", "--to", "canonical"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--from is required/);
    });
  });

  describe("--help", () => {
    it("shows usage", async () => {
      const result = await run(["--help"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /agent-perms/);
      assert.match(result.stderr, /convert/);
      assert.match(result.stderr, /validate/);
      assert.match(result.stderr, /check/);
    });
  });
});
