/** A ceiling layer bounds what deeper layers can allow; deeper layers can still only add restrictions. */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { evaluate } from "../evaluate.ts";
import { loadPolicy, mergeLayerPolicies, type PolicyLayer } from "../loader.ts";
import { AgentPermissionPolicy } from "../schema.ts";

function layers(...specs: [string, AgentPermissionPolicy][]): PolicyLayer[] {
  return specs.map(([source, policy]) => ({
    source,
    policy,
    ...(policy.ceiling === true ? { ceiling: true } : {}),
  }));
}

const org: AgentPermissionPolicy = {
  ceiling: true,
  defaultMode: "restricted",
  rules: [
    { tool: "Bash", pattern: "git:*", tier: "allow" },
    { tool: "Bash", pattern: "curl:*", tier: "deny" },
  ],
};

void describe("ceiling layers", () => {
  void it("let a deeper allow take effect where the ceiling also allows", () => {
    const policy = mergeLayerPolicies(
      layers(
        ["org", org],
        [
          "repo",
          { rules: [{ tool: "Bash", pattern: "git status", tier: "allow" }] },
        ],
      ),
    );
    assert.equal(evaluate(policy, "Bash", "git status"), "allow");
  });

  void it("ignore a deeper allow the ceiling does not cover", () => {
    const policy = mergeLayerPolicies(
      layers(
        ["org", org],
        [
          "repo",
          { rules: [{ tool: "Bash", pattern: "npm run *", tier: "allow" }] },
        ],
      ),
    );
    assert.equal(evaluate(policy, "Bash", "npm run build"), "ask");
  });

  void it("still allow what the ceiling layer itself allows", () => {
    const policy = mergeLayerPolicies(layers(["org", org], ["repo", {}]));
    assert.equal(evaluate(policy, "Bash", "git log"), "allow");
  });

  void it("do not stop a deeper layer adding a deny or an ask", () => {
    const policy = mergeLayerPolicies(
      layers(
        ["org", org],
        [
          "repo",
          {
            rules: [
              { tool: "Bash", pattern: "git push:*", tier: "ask" },
              { tool: "Bash", pattern: "git reset:*", tier: "deny" },
            ],
          },
        ],
      ),
    );
    assert.equal(evaluate(policy, "Bash", "git push origin"), "ask");
    assert.equal(evaluate(policy, "Bash", "git reset --hard"), "deny");
  });

  void it("do not bound a layer shallower than themselves", () => {
    const policy = mergeLayerPolicies(
      layers(
        [
          "user",
          { rules: [{ tool: "Bash", pattern: "npm run *", tier: "allow" }] },
        ],
        ["org", org],
      ),
    );
    assert.equal(evaluate(policy, "Bash", "npm run build"), "allow");
  });

  void it("bound nothing when the ceiling layer allows nothing", () => {
    const policy = mergeLayerPolicies(
      layers(
        [
          "org",
          {
            ceiling: true,
            rules: [{ tool: "Bash", pattern: "curl:*", tier: "deny" }],
          },
        ],
        [
          "repo",
          { rules: [{ tool: "Bash", pattern: "npm run *", tier: "allow" }] },
        ],
      ),
    );
    assert.equal(evaluate(policy, "Bash", "npm run build"), "allow");
  });

  void it("also bound a ceiling that sits below them", () => {
    const policy = mergeLayerPolicies(
      layers(
        ["org", org],
        [
          "team",
          {
            ceiling: true,
            rules: [{ tool: "Bash", pattern: "npm:*", tier: "allow" }],
          },
        ],
        [
          "repo",
          { rules: [{ tool: "Bash", pattern: "npm run *", tier: "allow" }] },
        ],
      ),
    );
    // The team's allow of npm is outside the org's ceiling, so it grants nothing, and the repo's is bounded by both.
    assert.equal(evaluate(policy, "Bash", "npm run build"), "ask");
    assert.equal(evaluate(policy, "Bash", "git status"), "allow");
  });

  void it("bound each command of a shell line", () => {
    const policy = mergeLayerPolicies(
      layers(
        ["org", org],
        [
          "repo",
          { rules: [{ tool: "Bash", pattern: "make:*", tier: "allow" }] },
        ],
      ),
    );
    assert.equal(evaluate(policy, "Bash", "git status && make all"), "ask");
  });

  void it("bind through a condition that is unknown", () => {
    const policy = mergeLayerPolicies(
      layers(
        [
          "org",
          {
            ceiling: true,
            rules: [
              {
                tool: "Bash",
                pattern: "git:*",
                tier: "allow",
                when: { branch: "main" },
              },
            ],
          },
        ],
        [
          "repo",
          { rules: [{ tool: "Bash", pattern: "git status", tier: "allow" }] },
        ],
      ),
    );
    assert.equal(
      evaluate(policy, "Bash", "git status", { branch: "main" }),
      "allow",
    );
    assert.equal(
      evaluate(policy, "Bash", "git status", { branch: "dev" }),
      "ask",
    );
    assert.equal(evaluate(policy, "Bash", "git status", {}), "ask");
  });

  void it("keep a deeper layer from loosening the default mode", () => {
    const policy = mergeLayerPolicies(
      layers(["org", org], ["repo", { defaultMode: "autonomous" }]),
    );
    assert.equal(policy.defaultMode, "restricted");
    assert.equal(evaluate(policy, "Read", "./a"), "ask");
  });

  void it("let a deeper layer tighten the default mode", () => {
    const policy = mergeLayerPolicies(
      layers(["org", org], ["repo", { defaultMode: "readonly" }]),
    );
    assert.equal(policy.defaultMode, "readonly");
  });

  void it("leave the default mode to the innermost layer when nothing is a ceiling", () => {
    const policy = mergeLayerPolicies(
      layers(
        ["user", { defaultMode: "restricted" }],
        ["repo", { defaultMode: "autonomous" }],
      ),
    );
    assert.equal(policy.defaultMode, "autonomous");
  });
});

void describe("ceiling in files", () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  void it("bounds a nested directory's policy by an outer one", async () => {
    const outer = await mkdtemp(join(tmpdir(), "ceiling-test-"));
    dirs.push(outer);
    const inner = join(outer, "project");
    await mkdir(join(outer, ".agents"), { recursive: true });
    await mkdir(join(inner, ".agents"), { recursive: true });
    await writeFile(
      join(outer, ".agents", "permissions.json"),
      JSON.stringify({ ...org }),
    );
    await writeFile(
      join(inner, ".agents", "permissions.json"),
      JSON.stringify({
        rules: [
          { tool: "Bash", pattern: "git status", tier: "allow" },
          { tool: "Bash", pattern: "npm run *", tier: "allow" },
        ],
      }),
    );
    const policy = await loadPolicy({ cwd: inner });
    assert.equal(evaluate(policy, "Bash", "git status"), "allow");
    assert.equal(evaluate(policy, "Bash", "npm run build"), "ask");
  });
});

void describe("ceiling in the schema", () => {
  void it("is a boolean", () => {
    assert.equal(
      AgentPermissionPolicy.safeParse({ ceiling: true }).success,
      true,
    );
    assert.equal(
      AgentPermissionPolicy.safeParse({ ceiling: "yes" }).success,
      false,
    );
  });
});
