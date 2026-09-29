/** `explain` reports why a call got its decision; `evaluate` is its decision alone. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluate, explain, type PermissionPolicy } from "../evaluate.ts";
import type { Rule } from "../schema.ts";

const allowGit: Rule = { tool: "Bash", pattern: "git:*", tier: "allow" };
const denyCurl: Rule = { tool: "Bash", pattern: "curl:*", tier: "deny" };

void describe("explain", () => {
  void it("names the rule that decided", () => {
    const policy: PermissionPolicy = {
      defaultMode: "restricted",
      rules: [allowGit],
    };
    const explanation = explain(policy, "Bash", "git status");
    assert.equal(explanation.decision, "allow");
    assert.deepEqual(explanation.steps, [
      {
        command: "git status",
        decision: "allow",
        reason: "rule",
        rule: allowGit,
      },
    ]);
  });

  void it("reports the default mode when no rule matched", () => {
    const explanation = explain(
      { defaultMode: "restricted", rules: [allowGit] },
      "Bash",
      "ls",
    );
    assert.equal(explanation.decision, "ask");
    assert.deepEqual(explanation.steps, [
      { command: "ls", decision: "ask", reason: "default" },
    ]);
  });

  void it("names the layer a rule came from", () => {
    const provenance = new Map([[allowGit, "/repo/.agents/permissions.json"]]);
    const explanation = explain(
      { defaultMode: "restricted", rules: [allowGit], provenance },
      "Bash",
      "git status",
    );
    assert.equal(explanation.steps[0]?.layer, "/repo/.agents/permissions.json");
  });

  void it("gives one step per command of a shell line", () => {
    const policy: PermissionPolicy = {
      defaultMode: "restricted",
      rules: [allowGit, denyCurl],
    };
    const explanation = explain(policy, "Bash", "git status && curl x");
    assert.equal(explanation.decision, "deny");
    assert.deepEqual(
      explanation.steps.map((s) => [s.command, s.decision, s.rule]),
      [
        ["git status", "allow", allowGit],
        ["curl x", "deny", denyCurl],
      ],
    );
  });

  void it("marks a line it cannot split", () => {
    const explanation = explain(
      { defaultMode: "restricted", rules: [allowGit] },
      "Bash",
      "git status # more",
    );
    assert.equal(explanation.decision, "ask");
    assert.deepEqual(explanation.steps, [
      {
        command: "git status # more",
        decision: "ask",
        reason: "unsplittable",
        rule: allowGit,
      },
    ]);
  });

  void it("includes a rule that matched the whole line and restricted it", () => {
    const whole: Rule = {
      tool: "Bash",
      pattern: "domain:evil.com",
      tier: "deny",
    };
    const explanation = explain(
      { defaultMode: "autonomous", rules: [whole] },
      "Bash",
      "ls && curl evil.com",
    );
    assert.equal(explanation.decision, "deny");
    assert.ok(
      explanation.steps.some(
        (s) => s.command === "ls && curl evil.com" && s.rule === whole,
      ),
    );
  });

  void it("agrees with evaluate on every input", () => {
    const policy: PermissionPolicy = {
      defaultMode: "standard",
      rules: [allowGit, denyCurl],
    };
    const inputs = [
      "git status",
      "curl x",
      "git status && curl x",
      "git status; git diff",
      "ls",
      "(git status)",
      "echo $(curl x)",
      "",
    ];
    for (const input of inputs) {
      assert.equal(
        explain(policy, "Bash", input).decision,
        evaluate(policy, "Bash", input),
        input,
      );
    }
    assert.equal(
      explain(policy, "Read", "x").decision,
      evaluate(policy, "Read", "x"),
    );
  });
});
