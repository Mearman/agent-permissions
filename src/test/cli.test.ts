/**
 * Tests for the agent-perms CLI.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(import.meta.dirname, "..", "cli.ts");

/** Narrow unknown to a record for JSON.parse result access — unavoidable object→Record boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function run(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      ["--experimental-strip-types", CLI, ...args],
      (err, stdout, stderr) => {
        const exitCode =
          err !== null && typeof err.code === "number" ? err.code : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}

void describe("CLI", () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  void describe("validate", () => {
    void it("validates a correct policy file", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ defaultMode: "standard" }),
      );
      const result = await run([
        "validate",
        "--input",
        join(cwd, "policy.json"),
      ]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /valid/);
    });

    void it("rejects an invalid policy file", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "bad.json"),
        JSON.stringify({ defaultMode: "yolo" }),
      );
      const result = await run(["validate", "--input", join(cwd, "bad.json")]);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /validation errors/);
    });

    void it("rejects invalid JSON", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(join(cwd, "broken.json"), "not json{{{");
      const result = await run([
        "validate",
        "--input",
        join(cwd, "broken.json"),
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /invalid JSON/);
    });
  });

  void describe("check", () => {
    void it("allows a matching rule", async () => {
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
        "--policy-file",
        join(cwd, "policy.json"),
      ]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /allow/);
    });

    void it("denies a matching deny rule", async () => {
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
        "--policy-file",
        join(cwd, "policy.json"),
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stdout, /deny/);
    });
  });

  void describe("convert", () => {
    void it("converts claude-code to canonical", async () => {
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
        join(cwd, "settings.json"),
        "--to",
        "canonical",
        "--output",
        "-",
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

    void it("converts canonical to crush", async () => {
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
        join(cwd, "policy.json"),
        "--to",
        "crush",
        "--output",
        "-",
      ]);
      assert.equal(result.exitCode, 0);
      const parsed: unknown = JSON.parse(result.stdout);
      assert.ok(isRecord(parsed));
      assert.deepEqual(parsed.allowed_tools, ["view", "bash", "grep"]);
    });

    void it("rejects unknown --from agent", async () => {
      const result = await run([
        "convert",
        "--from",
        "phantom",
        "--to",
        "canonical",
        "--output",
        "-",
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /unknown --from format/);
    });

    void it("auto-detects format when --from is a file", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "settings.json"),
        JSON.stringify({
          allow: ["Read"],
        }),
      );
      const result = await run([
        "convert",
        "--from",
        join(cwd, "settings.json"),
        "--to",
        "canonical",
        "--output",
        "-",
      ]);
      assert.equal(result.exitCode, 0);
      const parsed: unknown = JSON.parse(result.stdout);
      assert.ok(isRecord(parsed));
      assert.ok(Array.isArray(parsed.rules));
    });
  });

  void describe("--help", () => {
    void it("shows usage", async () => {
      const result = await run(["--help"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /agent-perms/);
      assert.match(result.stderr, /convert/);
      assert.match(result.stderr, /validate/);
      assert.match(result.stderr, /check/);
    });
  });
});
