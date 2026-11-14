import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { UnsupportedCapabilityError } from "../compat/unsupported.ts";
import { computeWriteTargets, sync, type SyncOptions } from "../sync.ts";

/** Narrow unknown to a record for JSON.parse result access — unavoidable object→Record boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

void describe("sync", () => {
  const dirs: string[] = [];

  // Clean up after all tests
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });
});

void describe("sync of roles and delegation across layers", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });
});

void describe("computeWriteTargets", () => {
  type Agent = "claude-code" | "codex" | "kiro" | "opencode" | "crush" | "omp";
  const rule = { tool: "Bash", pattern: "rm:*", tier: "deny" } as const;

  /** An encoder table where each agent encodes to an empty config unless told to throw. */
  function encoders(
    refusals: Partial<Record<Agent, () => never>>,
  ): Record<Agent, { encode: () => unknown }> {
    const encoderFor = (agent: Agent): { encode: () => unknown } => ({
      encode: (): unknown => {
        refusals[agent]?.();
        return { permissions: {} };
      },
    });
    return {
      "claude-code": encoderFor("claude-code"),
      codex: encoderFor("codex"),
      kiro: encoderFor("kiro"),
      opencode: encoderFor("opencode"),
      crush: encoderFor("crush"),
      omp: encoderFor("omp"),
    };
  }

  void it("reports an agent whose codec refuses the policy instead of skipping it", () => {
    const refusal = new UnsupportedCapabilityError("opencode", [
      { rule, reason: "no equivalent" },
    ]);
    const { targets, refused } = computeWriteTargets(
      tmpdir(),
      { rules: [rule] },
      [],
      undefined,
      true,
      encoders({
        opencode: () => {
          throw refusal;
        },
      }),
    );
    assert.deepEqual(refused, [refusal]);
    assert.equal(
      targets.some((t) => t.agent === "opencode"),
      false,
    );
  });

  void it("lets an unexpected error from a codec through", () => {
    assert.throws(
      () =>
        computeWriteTargets(
          tmpdir(),
          { rules: [rule] },
          [],
          undefined,
          true,
          encoders({
            kiro: () => {
              throw new TypeError("a bug in the codec");
            },
          }),
        ),
      TypeError,
    );
  });
});

void describe("sync of Oh My Pi's config", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  const projectConfig = [
    "# project settings",
    "model: fast # the quick one",
    "bash:",
    "  patterns:",
    "    - match: git *",
    "      approval: allow",
    "",
  ].join("\n");

  /** A project directory and an agent directory standing in for the home directory's, both temporary. */
  async function fixture(): Promise<{ cwd: string; agentDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "sync-omp-"));
    dirs.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "home", ".omp", "agent");
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    return { cwd, agentDir };
  }

  function options(
    cwd: string,
    agentDir: string,
    overrides: Partial<SyncOptions> = {},
  ): SyncOptions {
    return {
      cwd,
      up: 0,
      with: [],
      without: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
      ompAgentDir: agentDir,
      ompGlobal: false,
      ...overrides,
    };
  }

  async function writeCanonical(
    cwd: string,
    policy: Record<string, unknown>,
  ): Promise<void> {
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify(policy),
    );
  }

  void it("writes the merged bash.patterns and approval mode into the project file, keeping everything else", async () => {
    const { cwd, agentDir } = await fixture();
    await writeCanonical(cwd, {
      defaultMode: "standard",
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    });
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);

    const result = await sync(options(cwd, agentDir));

    assert.equal(result.applied, true);
    const written = await readFile(join(cwd, ".omp", "config.yml"), "utf-8");
    assert.match(written, /# project settings/);
    assert.match(written, /model: fast # the quick one/);
    assert.deepEqual(parseYaml(written), {
      model: "fast",
      bash: {
        patterns: [
          { match: "rm", approval: "deny" },
          { match: "rm *", approval: "deny" },
          { match: "git", approval: "allow" },
          { match: "git *", approval: "allow" },
        ],
      },
      tools: { approvalMode: "always-ask" },
    });
  });

  void it("writes nothing when the Oh My Pi codec refuses the policy", async () => {
    const { cwd, agentDir } = await fixture();
    const canonical = {
      rules: [{ tool: "Write", pattern: "./secrets", tier: "deny" }],
    };
    await writeCanonical(cwd, canonical);
    await mkdir(join(cwd, ".omp"));
    await writeFile(join(cwd, ".omp", "config.yml"), projectConfig);

    const result = await sync(options(cwd, agentDir));

    assert.equal(result.applied, false);
    assert.deepEqual(
      result.refused.map((e) => e.agent),
      ["omp"],
    );
    assert.equal(
      await readFile(join(cwd, ".omp", "config.yml"), "utf-8"),
      projectConfig,
    );
    assert.equal(
      await readFile(join(cwd, ".agents", "permissions.json"), "utf-8"),
      JSON.stringify(canonical),
    );
  });
});

void describe("sync of native JSON configs that hold other settings", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  async function project(canonical: Record<string, unknown>): Promise<string> {
    const cwd = await mkdtemp(join(tmpdir(), "sync-keep-"));
    dirs.push(cwd);
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "permissions.json"),
      JSON.stringify(canonical),
    );
    return cwd;
  }

  function options(
    cwd: string,
    overrides: Partial<SyncOptions> = {},
  ): SyncOptions {
    return {
      cwd,
      up: 0,
      with: [],
      without: [],
      yes: true,
      dryRun: false,
      create: false,
      verbose: false,
      backup: false,
      ompAgentDir: join(tmpdir(), "no-omp-agent"),
      ompGlobal: false,
      ...overrides,
    };
  }

  async function writeNative(
    cwd: string,
    path: string,
    content: string,
  ): Promise<void> {
    await mkdir(join(cwd, path, ".."), { recursive: true });
    await writeFile(join(cwd, path), content);
  }

  async function readJson(path: string): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    assert.ok(isRecord(parsed));
    return parsed;
  }

  const denyRm = { tool: "Bash", pattern: "rm:*", tier: "deny" } as const;
  const hooks = {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" }] }],
  };

  void it("keeps every other key of .claude/settings.json, in order", async () => {
    const cwd = await project({ rules: [denyRm] });
    await writeNative(
      cwd,
      ".claude/settings.json",
      JSON.stringify({
        model: "opus",
        permissions: { allow: ["Read"] },
        env: { A: "1" },
        hooks,
      }),
    );

    await sync(options(cwd));

    const settings = await readJson(join(cwd, ".claude", "settings.json"));
    assert.deepEqual(Object.keys(settings), [
      "model",
      "permissions",
      "env",
      "hooks",
    ]);
    assert.equal(settings.model, "opus");
    assert.deepEqual(settings.env, { A: "1" });
    assert.deepEqual(settings.hooks, hooks);
    assert.deepEqual(settings.permissions, {
      allow: ["Read"],
      deny: ["Bash(rm:*)"],
      ask: [],
    });
  });
});
