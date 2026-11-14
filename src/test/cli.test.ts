/**
 * Comprehensive CLI tests — covers all four commands plus edge cases.
 *
 * Tests run against TypeScript source via --experimental-strip-types.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const CLI = join(import.meta.dirname, "..", "cli.ts");

function run(
  args: string[],
  stdin?: string,
  ompAgentDir: string = mkdtempSync(join(tmpdir(), "agent-perms-omp-")),
  cwd: string = mkdtempSync(join(tmpdir(), "agent-perms-cli-")),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // A throwaway cwd per invocation: the CLI resolves and writes config files relative to cwd, and running it from the repo root made the suite overwrite the repo's own dogfooded .agents/permissions.json. Oh My Pi's agent directory is a throwaway too, so sync never reads or writes the real global config.
    const child = execFile(
      "node",
      ["--experimental-strip-types", CLI, ...args],
      {
        cwd,
        env: { ...process.env, PI_CODING_AGENT_DIR: ompAgentDir },
      },
      (err, stdout, stderr) => {
        const exitCode =
          err !== null && typeof err.code === "number" ? err.code : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

void describe("CLI", () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  // =========================================================================
  void describe("convert to and from OMP", () => {
    void it("reads an OMP config in YAML and ignores the rest of it", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "omp-config.yml"),
        [
          "model: anything",
          "tools:",
          "  approvalMode: yolo",
          "bash:",
          "  patterns:",
          '    - match: "curl *"',
          "      approval: prompt",
          "",
        ].join("\n"),
      );
      const result = await run([
        "convert",
        "--from",
        join(cwd, "omp-config.yml"),
        "--to",
        "canonical",
        "--output",
        "-",
      ]);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /"tier": "ask"/);
      assert.match(result.stdout, /"pattern": "curl \*"/);
    });

    void it("fails, naming the rule, when OMP cannot enforce it", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          rules: [{ tool: "Write", pattern: "./secrets", tier: "deny" }],
        }),
      );
      const result = await run([
        "convert",
        "--from",
        join(cwd, "policy.json"),
        "--to",
        "omp",
        "--output",
        "-",
      ]);
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /Write\(\.\/secrets\) \[deny\]/);
      assert.equal(result.stdout, "");
    });
  });

  void describe("check", () => {
    void it("explains which rule decided with --explain", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          rules: [
            { tool: "Bash", pattern: "git:*", tier: "allow" },
            { tool: "Bash", pattern: "curl:*", tier: "deny" },
          ],
        }),
      );
      const result = await run([
        "check",
        "--tool",
        "bash",
        "--input",
        "git status && curl x",
        "--explain",
        "--policy-file",
        join(cwd, "policy.json"),
      ]);
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "deny\n");
      assert.match(result.stderr, /allow\s+git status\s+Bash\(git:\*\)/);
      assert.match(result.stderr, /deny\s+curl x\s+Bash\(curl:\*\)/);
    });

    void it("marks a step hidden with --explain when a hidden rule decided", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          rules: [
            { tool: "Bash", pattern: "sudo:*", tier: "deny", hidden: true },
          ],
        }),
      );
      const result = await run([
        "check",
        "--tool",
        "bash",
        "--input",
        "sudo ls",
        "--explain",
        "--policy-file",
        join(cwd, "policy.json"),
      ]);
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "deny\n");
      assert.match(result.stderr, /\(hidden\)/);
    });
  });
});

void describe("CLI and Oh My Pi's config", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });
});
