/** The `delegation` limits: how deep agents nest and which tools a subagent may not use. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkSpawn,
  evaluate,
  explain,
  type PermissionPolicy,
} from "../evaluate.ts";

const policy: PermissionPolicy = {
  defaultMode: "autonomous",
  rules: [],
  delegation: {
    maxDepth: 2,
    nonDelegable: [
      { tool: "Bash", pattern: "sudo:*", tier: "deny" },
      { tool: "Write", pattern: "./.agents/**", tier: "deny" },
    ],
  },
};

void describe("delegation.nonDelegable", () => {
  void it("denies a listed tool to a subagent", () => {
    assert.equal(evaluate(policy, "Bash", "sudo ls", { depth: 1 }), "deny");
    assert.equal(
      evaluate(policy, "Write", "./.agents/permissions.json", { depth: 2 }),
      "deny",
    );
  });

  void it("leaves the top-level agent alone, whether depth is 0 or not given", () => {
    assert.equal(evaluate(policy, "Bash", "sudo ls", { depth: 0 }), "allow");
    assert.equal(evaluate(policy, "Bash", "sudo ls"), "allow");
  });

  void it("leaves other calls of a subagent alone", () => {
    assert.equal(evaluate(policy, "Bash", "ls", { depth: 1 }), "allow");
  });

  void it("judges each command of a shell line", () => {
    assert.equal(
      evaluate(policy, "Bash", "ls && sudo rm x", { depth: 1 }),
      "deny",
    );
    assert.equal(
      evaluate(policy, "Bash", "ls && sudo rm x", { depth: 0 }),
      "allow",
    );
  });

  void it("says which rule and why", () => {
    const step = explain(policy, "Bash", "sudo ls", { depth: 1 }).steps[0];
    assert.equal(step?.reason, "delegation");
    assert.equal(step.rule?.pattern, "sudo:*");
  });
});

void describe("delegation.maxDepth", () => {
  void it("denies every call from an agent nested deeper than the limit", () => {
    assert.equal(evaluate(policy, "Read", "./a", { depth: 3 }), "deny");
    assert.equal(
      explain(policy, "Read", "./a", { depth: 3 }).steps[0]?.reason,
      "delegation",
    );
  });

  void it("allows an agent at the limit", () => {
    assert.equal(evaluate(policy, "Read", "./a", { depth: 2 }), "allow");
  });

  void it("has no limit when maxDepth is not set", () => {
    const unlimited: PermissionPolicy = {
      defaultMode: "autonomous",
      delegation: {},
    };
    assert.equal(evaluate(unlimited, "Read", "./a", { depth: 50 }), "allow");
  });
});

void describe("checkSpawn", () => {
  void it("allows spawning while the child would stay within maxDepth", () => {
    assert.equal(checkSpawn(policy, 0), "allow");
    assert.equal(checkSpawn(policy, 1), "allow");
  });

  void it("denies spawning past maxDepth", () => {
    assert.equal(checkSpawn(policy, 2), "deny");
  });

  void it("denies all spawning when maxDepth is 0", () => {
    assert.equal(
      checkSpawn({ defaultMode: "autonomous", delegation: { maxDepth: 0 } }, 0),
      "deny",
    );
  });

  void it("allows spawning when maxDepth is not set", () => {
    assert.equal(checkSpawn({ defaultMode: "standard" }, 10), "allow");
  });
});
