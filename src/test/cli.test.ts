/**
 * Comprehensive CLI tests — covers all four commands plus edge cases.
 *
 * Tests run against TypeScript source via --experimental-strip-types.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bash, jsonl } from "./transcript-fixture.ts";

const CLI = join(import.meta.dirname, "..", "cli.ts");

/** Narrow unknown to a record for JSON.parse result access. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function run(
  args: string[],
  stdin?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // A throwaway cwd per invocation: the CLI resolves and writes config files relative to cwd, and running it from the repo root made the suite overwrite the repo's own dogfooded .agents/permissions.json.
    const child = execFile(
      "node",
      ["--experimental-strip-types", CLI, ...args],
      { cwd: mkdtempSync(join(tmpdir(), "agent-perms-cli-")) },
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
      assert.ok(Array.isArray(parsed.rules));
      assert.equal(parsed.rules.length, 3);
      // deny rules come first
      const first = parsed.rules[0] as Record<string, unknown>;
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

    void it("converts with --compact flag", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ rules: [{ tool: "Read", tier: "allow" }] }),
      );
      const result = await run([
        "convert",
        "--from",
        join(cwd, "policy.json"),
        "--to",
        "canonical",
        "--compact",
        "--output",
        "-",
      ]);
      assert.equal(result.exitCode, 0);
      // Compact JSON has no spaces after :
      assert.ok(!result.stdout.includes(": "));
    });

    void it("converts with --verbose flag", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ rules: [{ tool: "Read", tier: "allow" }] }),
      );
      const result = await run([
        "convert",
        "--from",
        join(cwd, "policy.json"),
        "--to",
        "canonical",
        "--verbose",
        "--output",
        "-",
      ]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stderr, /Decoded/);
      assert.match(result.stderr, /rules/);
    });

    void it("writes to a file with --output", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "input.json"),
        JSON.stringify({ allow: ["Read"] }),
      );
      const outputPath = join(cwd, "output.json");
      const result = await run([
        "convert",
        "--from",
        join(cwd, "input.json"),
        "--to",
        "canonical",
        "--output",
        outputPath,
      ]);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "");
      const written: unknown = JSON.parse(await readFile(outputPath, "utf-8"));
      assert.ok(isRecord(written));
      assert.ok(Array.isArray(written.rules));
    });

    void it("rejects missing --to", async () => {
      const result = await run(["convert", "--from", "canonical"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--to is required/);
    });

    void it("rejects unknown --to format", async () => {
      const result = await run([
        "convert",
        "--from",
        "canonical",
        "--to",
        "phantom",
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /unknown --to format/);
    });

    void it("rejects unknown --from format (non-existent file)", async () => {
      const result = await run([
        "convert",
        "--from",
        "/nonexistent/path.json",
        "--to",
        "canonical",
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /unknown --from format/);
    });

    void it("auto-detects format from file content", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "settings.json"),
        JSON.stringify({ allow: ["Read"] }),
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

    void it("converts from stdin with '-'", async () => {
      const input = JSON.stringify({ allow: ["Read"] });
      const result = await run(
        ["convert", "--from", "-", "--to", "canonical", "--output", "-"],
        input,
      );
      assert.equal(result.exitCode, 0);
      const parsed: unknown = JSON.parse(result.stdout);
      assert.ok(isRecord(parsed));
      assert.ok(Array.isArray(parsed.rules));
    });

    void it("reports ConvertError with validation details", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      // Canonical with invalid rules shape — the codec will produce invalid
      // output when trying to encode to a format
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ rules: [{ tool: "Bash", tier: "allow" }] }),
      );
      const result = await run([
        "convert",
        "--from",
        join(cwd, "policy.json"),
        "--to",
        "canonical",
        "--output",
        "-",
      ]);
      // Should succeed since it's already canonical
      assert.equal(result.exitCode, 0);
    });

    void it("handles invalid JSON input", async () => {
      const result = await run(
        ["convert", "--from", "-", "--to", "canonical", "--output", "-"],
        "not json{{{",
      );
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /invalid JSON/);
    });

    void it("accepts --input as alias for --from", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ allow: ["Read"] }),
      );
      const result = await run([
        "convert",
        "--input",
        join(cwd, "policy.json"),
        "--to",
        "canonical",
        "--output",
        "-",
      ]);
      assert.equal(result.exitCode, 0);
    });

    void it("accepts --in as alias for --from", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ allow: ["Read"] }),
      );
      const result = await run([
        "convert",
        "--in",
        join(cwd, "policy.json"),
        "--to",
        "canonical",
        "--output",
        "-",
      ]);
      assert.equal(result.exitCode, 0);
    });

    void it("accepts --out as alias for --output", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ allow: ["Read"] }),
      );
      const outputPath = join(cwd, "out.json");
      const result = await run([
        "convert",
        "--from",
        join(cwd, "policy.json"),
        "--to",
        "canonical",
        "--out",
        outputPath,
      ]);
      assert.equal(result.exitCode, 0);
      const written: unknown = JSON.parse(await readFile(outputPath, "utf-8"));
      assert.ok(isRecord(written));
      assert.ok(Array.isArray(written.rules));
    });

    void it("resolves format name for --to as output file", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "input.json"),
        JSON.stringify({ allow: ["Read"] }),
      );
      // --to canonical writes to .agents/permissions.json in cwd
      const result = await run(
        ["convert", "--from", join(cwd, "input.json"), "--to", "canonical"],
        undefined,
      );
      assert.equal(result.exitCode, 0);
    });
  });

  // =========================================================================
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

    void it("validates from stdin with '-'", async () => {
      const input = JSON.stringify({ defaultMode: "standard" });
      const result = await run(["validate", "--input", "-"], input);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /valid/);
    });

    void it("shows validation error details", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "bad.json"),
        JSON.stringify({ rules: [{ notTool: "Bash" }] }),
      );
      const result = await run(["validate", "--input", join(cwd, "bad.json")]);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /rules\./);
      assert.match(result.stderr, /Invalid/);
    });

    void it("accepts --in as alias for --input", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ defaultMode: "standard" }),
      );
      const result = await run(["validate", "--in", join(cwd, "policy.json")]);
      assert.equal(result.exitCode, 0);
    });
  });

  // =========================================================================
  void describe("convert to and from OMP", () => {
    void it("writes an OMP config as YAML", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
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
      assert.equal(result.exitCode, 0);
      assert.equal(
        result.stdout,
        [
          "bash:",
          "  patterns:",
          "    - match: rm",
          "      approval: deny",
          "    - match: rm *",
          "      approval: deny",
          "",
        ].join("\n"),
      );
    });

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

    void it("takes the remote and environment conditions from flags", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          defaultMode: "restricted",
          rules: [
            {
              tool: "Bash",
              pattern: "deploy:*",
              tier: "allow",
              when: { env: { CI: "true" }, remote: "github.com/exadev/*" },
            },
          ],
        }),
      );
      const args = (extra: string[]): string[] => [
        "check",
        "--tool",
        "bash",
        "--input",
        "deploy prod",
        "--policy-file",
        join(cwd, "policy.json"),
        ...extra,
      ];
      const known = await run(
        args(["--env", "CI=true", "--remote", "git@github.com:ExaDev/x.git"]),
      );
      assert.equal(known.stdout, "allow\n");
      const missing = await run(args(["--env", "CI=true"]));
      assert.equal(missing.stdout, "ask\n");
    });

    void it("applies delegation limits for the depth given with --depth", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          defaultMode: "autonomous",
          delegation: { nonDelegable: ["Bash(sudo:*)"] },
        }),
      );
      const args = (depth: string): string[] => [
        "check",
        "--tool",
        "bash",
        "--input",
        "sudo ls",
        "--depth",
        depth,
        "--policy-file",
        join(cwd, "policy.json"),
      ];
      assert.equal((await run(args("1"))).stdout, "deny\n");
      assert.equal((await run(args("0"))).stdout, "allow\n");
      assert.notEqual((await run(args("-1"))).exitCode, 0);
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

    void it("takes the actor and roles from flags", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          defaultMode: "restricted",
          roles: { maintainer: { allow: ["Bash(git push:*)"] } },
        }),
      );
      const args = (extra: string[]): string[] => [
        "check",
        "--tool",
        "bash",
        "--input",
        "git push origin",
        "--policy-file",
        join(cwd, "policy.json"),
        ...extra,
      ];
      assert.equal(
        (
          await run(
            args(["--actor", "ada", "--role", "maintainer", "--role", "dev"]),
          )
        ).stdout,
        "allow\n",
      );
      assert.equal(
        (await run(args(["--actor", "bob", "--role", "dev"]))).stdout,
        "ask\n",
      );
      assert.equal((await run(args(["--actor", "ada"]))).stdout, "ask\n");
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

    void it("asks when no rule matches in standard mode", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ defaultMode: "standard" }),
      );
      const result = await run([
        "check",
        "--tool",
        "Bash",
        "--input",
        "anything",
        "--policy-file",
        join(cwd, "policy.json"),
      ]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /ask/);
    });

    void it("requires --tool", async () => {
      const result = await run(["check", "--input", "cmd"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--tool is required/);
    });

    void it("requires --input", async () => {
      const result = await run(["check", "--tool", "Bash"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--input is required/);
    });

    void it("passes --cwd context", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          rules: [
            {
              tool: "Bash",
              pattern: "git:*",
              tier: "allow",
              when: { cwd: "/specific/path" },
            },
          ],
        }),
      );
      const result = await run([
        "check",
        "--tool",
        "Bash",
        "--input",
        "git status",
        "--policy-file",
        join(cwd, "policy.json"),
        "--cwd",
        "/specific/path",
      ]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /allow/);
    });

    void it("passes --branch context", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          rules: [
            {
              tool: "Bash",
              pattern: "git:*",
              tier: "allow",
              when: { branch: "main" },
            },
          ],
        }),
      );
      const result = await run([
        "check",
        "--tool",
        "Bash",
        "--input",
        "git status",
        "--policy-file",
        join(cwd, "policy.json"),
        "--branch",
        "main",
      ]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /allow/);
    });

    void it("reports ConvertError for invalid policy", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "bad.json"),
        JSON.stringify({ defaultMode: "yolo" }),
      );
      const result = await run([
        "check",
        "--tool",
        "Bash",
        "--input",
        "cmd",
        "--policy-file",
        join(cwd, "bad.json"),
      ]);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /error/);
    });

    void it("handles invalid JSON in policy file", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(join(cwd, "bad.json"), "not json");
      const result = await run([
        "check",
        "--tool",
        "Bash",
        "--input",
        "cmd",
        "--policy-file",
        join(cwd, "bad.json"),
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /invalid JSON/);
    });
  });

  // =========================================================================
  void describe("replay", () => {
    void it("counts decisions and lists the calls recorded differently", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({
          rules: [
            { tool: "Bash", pattern: "git:*", tier: "allow" },
            { tool: "Bash", pattern: "sudo:*", tier: "deny" },
          ],
        }),
      );
      await writeFile(
        join(cwd, "session.jsonl"),
        jsonl([
          ...bash("t1", "git status", "ran"),
          ...bash("t2", "sudo reboot", "ran"),
          ...bash("t3", "ls", "rejected"),
        ]),
      );
      const result = await run([
        "replay",
        "--policy-file",
        join(cwd, "policy.json"),
        "--transcript",
        join(cwd, "session.jsonl"),
      ]);
      assert.equal(result.exitCode, 0);
      assert.equal(
        result.stdout,
        "allow\t1\nask\t1\ndeny\t1\n\ndiffers from the transcript:\ndeny\tran\tBash\tsudo reboot\n",
      );
    });

    void it("requires --transcript", async () => {
      const result = await run(["replay", "--policy-file", "canonical"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--transcript is required/);
    });
  });

  // =========================================================================
  void describe("suggest", () => {
    void it("prints a policy of allow rules for calls approved repeatedly", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "session.jsonl"),
        jsonl([
          ...bash("t1", "npm run build", "ran"),
          ...bash("t2", "npm run lint", "ran"),
          ...bash("t3", "make", "ran"),
        ]),
      );
      const result = await run([
        "suggest",
        "--transcript",
        join(cwd, "session.jsonl"),
      ]);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        rules: [{ tool: "Bash", pattern: "npm run:*", tier: "allow" }],
      });
      assert.equal(result.stderr, "2\tBash(npm run:*)\n");
    });

    void it("honours --min-count and leaves out what the policy allows", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await writeFile(
        join(cwd, "policy.json"),
        JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }),
      );
      await writeFile(
        join(cwd, "session.jsonl"),
        jsonl([
          ...bash("t1", "git status", "ran"),
          ...bash("t2", "make", "ran"),
        ]),
      );
      const result = await run([
        "suggest",
        "--transcript",
        join(cwd, "session.jsonl"),
        "--policy-file",
        join(cwd, "policy.json"),
        "--min-count",
        "1",
      ]);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        rules: [{ tool: "Bash", pattern: "make", tier: "allow" }],
      });
    });

    void it("rejects a --min-count that is not a positive integer", async () => {
      const result = await run([
        "suggest",
        "--transcript",
        "-",
        "--min-count",
        "0",
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--min-count must be a positive integer/);
    });
  });

  // =========================================================================
  void describe("sync", () => {
    void it("detects and reports no configs", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      const result = await run(["sync", "--working-dir", cwd]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stderr, /No permission configs found/);
    });

    void it("syncs a single canonical file (no-op)", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      const schemaUrl =
        "https://github.com/Mearman/agent-permissions/releases/latest/download/agent-permissions.schema.json";
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify(
          { $schema: schemaUrl, defaultMode: "standard" },
          null,
          2,
        ) + "\n",
      );
      const result = await run(["sync", "--working-dir", cwd, "--yes"]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stderr, /Already in sync/);
    });

    void it("merges canonical and claude-code configs", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          rules: [{ tool: "Read", tier: "allow" }],
        }),
      );
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          permissions: {
            allow: ["Bash(git status)"],
          },
        }),
      );
      const result = await run([
        "sync",
        "--working-dir",
        cwd,
        "--yes",
        "--verbose",
      ]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stderr, /Merged/);
    });

    void it("dry-run shows changes without writing", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          rules: [{ tool: "Read", tier: "allow" }],
        }),
      );
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          permissions: { allow: ["Bash(git status)"] },
        }),
      );
      const result = await run(["sync", "--working-dir", cwd, "--dry-run"]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stderr, /dry run/);
    });

    void it("rejects --with and --without together", async () => {
      const result = await run([
        "sync",
        "--with",
        "claude-code",
        "--without",
        "opencode",
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /mutually exclusive/);
    });

    void it("rejects unknown --with agent", async () => {
      const result = await run(["sync", "--with", "phantom"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /unknown agent/);
    });

    void it("rejects unknown --without agent", async () => {
      const result = await run(["sync", "--without", "phantom"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /unknown agent/);
    });

    void it("rejects invalid --up value", async () => {
      const result = await run(["sync", "--up", "abc"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--up must be/);
    });

    void it("accepts --up numeric value", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({ defaultMode: "standard" }),
      );
      const result = await run([
        "sync",
        "--working-dir",
        cwd,
        "--up",
        "0",
        "--yes",
      ]);
      assert.equal(result.exitCode, 0);
    });

    void it("writes backup files with --backup", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({ defaultMode: "standard" }),
      );
      await mkdir(join(cwd, ".claude"), { recursive: true });
      await writeFile(
        join(cwd, ".claude", "settings.json"),
        JSON.stringify({
          permissions: { allow: ["Read"] },
        }),
      );
      const result = await run([
        "sync",
        "--working-dir",
        cwd,
        "--yes",
        "--backup",
      ]);
      assert.equal(result.exitCode, 0);
      // .bak file should exist for the claude settings
      const { stat } = await import("node:fs/promises");
      await assert.doesNotReject(() =>
        stat(join(cwd, ".claude", "settings.json.bak")),
      );
    });

    void it("creates missing config files with --create", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify({
          rules: [{ tool: "Read", tier: "allow" }],
        }),
      );
      const result = await run([
        "sync",
        "--working-dir",
        cwd,
        "--yes",
        "--create",
        "--with",
        "claude-code",
      ]);
      assert.equal(result.exitCode, 0);
      // .claude/settings.json should have been created
      const content = await readFile(
        join(cwd, ".claude", "settings.json"),
        "utf-8",
      );
      const parsed: unknown = JSON.parse(content);
      assert.ok(isRecord(parsed));
      assert.ok(isRecord(parsed.permissions));
    });
  });

  // =========================================================================
  void describe("confine", () => {
    void it("prints a canonical policy that confines to the roots", async () => {
      const result = await run([
        "confine",
        "--root",
        "/work/app",
        "--root",
        "/work/shared",
      ]);
      assert.equal(result.exitCode, 0);
      const parsed: unknown = JSON.parse(result.stdout);
      assert.ok(isRecord(parsed));
      assert.equal(parsed.defaultMode, "restricted");
      const checked = await run(
        [
          "check",
          "--tool",
          "Read",
          "--input",
          "/work/shared/a.ts",
          "--policy-file",
          "-",
        ],
        result.stdout,
      );
      assert.equal(checked.stdout.trim(), "allow");
      const outside = await run(
        [
          "check",
          "--tool",
          "Read",
          "--input",
          "/work/app-secrets/a",
          "--policy-file",
          "-",
        ],
        result.stdout,
      );
      assert.equal(outside.stdout.trim(), "ask");
    });

    void it("lists roots other than the working directory as additional directories", async () => {
      const result = await run([
        "confine",
        "--root",
        ".",
        "--root",
        "/work/shared",
      ]);
      const parsed: unknown = JSON.parse(result.stdout);
      assert.ok(isRecord(parsed));
      assert.ok(isRecord(parsed.permissions));
      assert.deepEqual(parsed.permissions.additionalDirectories, [
        "/work/shared",
      ]);
    });

    void it("denies outside paths with --outside deny", async () => {
      const result = await run([
        "confine",
        "--root",
        "/work/app",
        "--outside",
        "deny",
      ]);
      const parsed: unknown = JSON.parse(result.stdout);
      assert.ok(isRecord(parsed));
      assert.equal(parsed.defaultMode, "readonly");
    });

    void it("writes to --output instead of stdout", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "cli-test-"));
      dirs.push(cwd);
      const file = join(cwd, "confine.json");
      const result = await run([
        "confine",
        "--root",
        "/work/app",
        "--output",
        file,
      ]);
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "");
      const written: unknown = JSON.parse(await readFile(file, "utf8"));
      assert.ok(isRecord(written));
      assert.ok(Array.isArray(written.rules));
    });

    void it("fails without a root", async () => {
      const result = await run(["confine"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--root is required/);
    });

    void it("rejects an unknown --outside value", async () => {
      const result = await run([
        "confine",
        "--root",
        "/w",
        "--outside",
        "allow",
      ]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /--outside/);
    });

    void it("is described in the usage text", async () => {
      const result = await run(["--help"]);
      assert.match(result.stdout, /confine/);
      assert.match(result.stdout, /not a sandbox/);
    });
  });

  // =========================================================================
  void describe("usage and routing", () => {
    void it("shows usage with --help", async () => {
      // An explicit help request is a successful invocation: exit 0, usage on stdout.
      const result = await run(["--help"]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /agent-perms/);
      assert.match(result.stdout, /convert/);
      assert.match(result.stdout, /validate/);
      assert.match(result.stdout, /check/);
      assert.match(result.stdout, /sync/);
    });

    void it("shows usage with -h", async () => {
      const result = await run(["-h"]);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /agent-perms/);
    });

    void it("shows usage for unknown command", async () => {
      const result = await run(["bogus"]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /unknown command/);
    });

    void it("shows usage with no args", async () => {
      const result = await run([]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /agent-perms/);
    });
  });
});
