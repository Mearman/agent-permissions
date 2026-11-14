import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

/** Every file under a directory with its bytes, so a run can be shown to have written nothing. */
async function snapshot(root: string, dir = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await snapshot(root, full)));
    else
      found.push(
        `${full.slice(root.length)}=${(await readFile(full)).toString("base64")}`,
      );
  }
  return found.sort();
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

/** An existing policy or agent config file, the format that names it, and content a merge could damage. */
const EXISTING: [string, string, string][] = [
  [
    ".agents/permissions.json",
    "canonical",
    '{"sandbox": {"mode": "workspace-write"}, "env": {"A": "1"}}\n',
  ],
  [
    ".agents/permissions.local.json",
    "canonical",
    '{"sync": {"mode": "watch"}}\n',
  ],
  [
    ".claude/settings.json",
    "claude-code",
    '{"model": "opus", "permissions": {"deny": ["Bash(rm:*)"]}}\n',
  ],
  [
    ".claude/settings.local.json",
    "claude-code",
    '{"permissions": {"deny": ["Bash(sudo:*)"]}}\n',
  ],
  ["opencode.json", "opencode", '{"permission": {"bash": {"rm *": "deny"}}}\n'],
  [
    "opencode.jsonc",
    "opencode",
    '{\n  // mine\n  "permission": {"edit": "deny"}\n}\n',
  ],
  [
    ".kiro/permissions.json",
    "kiro",
    '{"toolsSettings": {"shell": {"deniedCommands": ["\\\\Arm\\\\z"]}}}\n',
  ],
  ["codex.toml", "codex", 'approval_policy = "never"\n'],
  [
    ".omp/config.yml",
    "omp",
    "# mine\nbash:\n  patterns:\n    - match: sudo *\n      approval: deny\n",
  ],
  [".crush.json", "crush", '{"permissions": {"allowed_tools": ["view"]}}\n'],
];

void describe("convert and confine create config files and refuse to overwrite one", () => {
  for (const [path, format, text] of EXISTING) {
    void it(`convert refuses an existing ${path}, naming it, and writes nothing`, async () => {
      const cwd = await project();
      await mkdir(join(cwd, path, ".."), { recursive: true });
      await writeFile(join(cwd, path), text);
      const before = await snapshot(cwd);

      const result = await run(cwd, [
        "convert",
        "--from",
        join(cwd, "policy.json"),
        "--to",
        format,
        "--output",
        join(cwd, path),
      ]);

      assert.equal(result.exitCode, 1, result.stderr);
      assert.ok(result.stderr.includes(path), result.stderr);
      assert.match(result.stderr, /sync/u);
      assert.deepEqual(await snapshot(cwd), before);
    });

    void it(`confine refuses an existing ${path}, naming it, and writes nothing`, async () => {
      const cwd = await project();
      await mkdir(join(cwd, path, ".."), { recursive: true });
      await writeFile(join(cwd, path), text);
      const before = await snapshot(cwd);

      const result = await run(cwd, [
        "confine",
        "--root",
        cwd,
        "--output",
        join(cwd, path),
      ]);

      assert.equal(result.exitCode, 1, result.stderr);
      assert.ok(result.stderr.includes(path), result.stderr);
      assert.match(result.stderr, /sync/u);
      assert.deepEqual(await snapshot(cwd), before);
    });
  }

  void it("refuses Oh My Pi's global config, found through its agent directory", async () => {
    const cwd = await project();
    const agentDir = join(cwd, "omp-home");
    await mkdir(agentDir);
    const text = "# mine\nmodel: fast\n";
    await writeFile(join(agentDir, "config.yml"), text);
    const before = await snapshot(cwd);

    for (const args of [
      [
        "convert",
        "--from",
        join(cwd, "policy.json"),
        "--to",
        "omp",
        "--output",
        join(agentDir, "config.yml"),
      ],
      ["confine", "--root", cwd, "--output", join(agentDir, "config.yml")],
    ]) {
      const result = await run(cwd, args, { PI_CODING_AGENT_DIR: agentDir });

      assert.equal(result.exitCode, 1, result.stderr);
      assert.ok(result.stderr.includes("config.yml"), result.stderr);
      assert.deepEqual(await snapshot(cwd), before);
    }
  });

  void it("refuses a bare format name that resolves to an existing file", async () => {
    const cwd = await project();
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      '{"env": {"A": "1"}}\n',
    );
    const before = await snapshot(cwd);

    const result = await run(cwd, [
      "confine",
      "--root",
      cwd,
      "--output",
      "canonical",
    ]);

    assert.equal(result.exitCode, 1, result.stderr);
    assert.deepEqual(await snapshot(cwd), before);
  });

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

  void it("refuses another agent's config file than --to names, whether or not it exists", async () => {
    const cwd = await project();

    const result = await run(cwd, [
      "convert",
      "--from",
      join(cwd, "policy.json"),
      "--to",
      "opencode",
      "--output",
      join(cwd, ".claude", "settings.json"),
    ]);

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /settings\.json.*claude-code.*opencode/u);
    assert.deepEqual((await readdir(cwd)).sort(), ["policy.json"]);
  });
});

void describe("convert and confine create a config file that does not exist yet", () => {
  void it("writes a native file wrapped as that agent reads it", async () => {
    const cwd = await project();
    const target = join(cwd, ".claude", "settings.json");

    const result = await run(cwd, [
      "convert",
      "--from",
      join(cwd, "policy.json"),
      "--to",
      "claude-code",
      "--output",
      target,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const written: unknown = JSON.parse(await readFile(target, "utf-8"));
    assert.ok(
      typeof written === "object" &&
        written !== null &&
        "permissions" in written,
    );
  });

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

  void it("writes the encoded document whole to a path that is no agent's config file", async () => {
    const cwd = await project();
    const target = join(cwd, "out.json");
    await writeFile(target, '{"model": "opus"}');

    const result = await run(cwd, [
      "convert",
      "--from",
      join(cwd, "policy.json"),
      "--to",
      "claude-code",
      "--output",
      target,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(await readFile(target, "utf-8"), /model/u);
  });
});
