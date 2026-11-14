import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const CLI = join(import.meta.dirname, "..", "cli.ts");

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Run the CLI in a directory. */
function run(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      ["--experimental-strip-types", CLI, ...args],
      { cwd, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const exitCode =
          error !== null && typeof error.code === "number" ? error.code : 0;
        resolve({ exitCode, stdout, stderr });
      },
    );
  });
}

async function project(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "cli-output-"));
  dirs.push(cwd);
  await writeFile(
    join(cwd, "policy.json"),
    JSON.stringify({ rules: [{ tool: "Read", tier: "allow" }] }),
  );
  return cwd;
}

void describe("convert and confine create config files and refuse to overwrite one", () => {
  void it("says a directory at the output path is a directory", async () => {
    const cwd = await project();
    await mkdir(join(cwd, "codex.toml"));

    const result = await run(cwd, [
      "confine",
      "--root",
      cwd,
      "--output",
      join(cwd, "codex.toml"),
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /codex\.toml is a directory/u);
    assert.doesNotMatch(result.stderr, /already exists/u);
  });
});

void describe("convert and confine create a config file that does not exist yet", () => {
  void it("writes a canonical policy", async () => {
    const cwd = await project();
    const target = join(cwd, ".agents", "permissions.json");

    const result = await run(cwd, [
      "confine",
      "--root",
      cwd,
      "--output",
      target,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(await readFile(target, "utf-8"), /"rules"/u);
  });
});
