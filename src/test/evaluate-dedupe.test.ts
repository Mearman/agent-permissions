/** Rules that differ only in their `when` condition are different rules. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deduplicateRules,
  evaluate,
  ruleKey,
  type PermissionPolicy,
} from "../evaluate.ts";
import type { Rule } from "../schema.ts";

const scopedAllow: Rule = {
  tool: "Bash",
  pattern: "npm run *",
  tier: "allow",
  when: { cwd: "./packages/*" },
};
const scopedDeny: Rule = {
  tool: "Bash",
  pattern: "npm run *",
  tier: "deny",
  when: { cwd: "./infra/*" },
};

void describe("deduplicateRules", () => {
  void it("keeps rules that share a tool and pattern but differ in their condition", () => {
    assert.deepEqual(deduplicateRules([scopedAllow, scopedDeny]), [
      scopedAllow,
      scopedDeny,
    ]);
  });

  void it("does not change what a policy decides", () => {
    const rules = [scopedAllow, scopedDeny];
    const policy: PermissionPolicy = { defaultMode: "restricted", rules };
    const deduplicated: PermissionPolicy = {
      defaultMode: "restricted",
      rules: deduplicateRules(rules),
    };
    for (const cwd of ["./packages/a", "./infra/a", "./other"]) {
      assert.equal(
        evaluate(deduplicated, "bash", "npm run build", { cwd }),
        evaluate(policy, "bash", "npm run build", { cwd }),
        cwd,
      );
    }
  });

  void it("keeps the stricter tier when the condition is the same", () => {
    const allow: Rule = { ...scopedAllow };
    const deny: Rule = { ...scopedAllow, tier: "deny" };
    assert.deepEqual(deduplicateRules([allow, deny]), [deny]);
    assert.deepEqual(deduplicateRules([deny, allow]), [deny]);
  });

  void it("treats an unconditional rule and a conditional one as different", () => {
    const unconditional: Rule = {
      tool: "Bash",
      pattern: "npm run *",
      tier: "allow",
    };
    assert.deepEqual(deduplicateRules([unconditional, scopedAllow]), [
      unconditional,
      scopedAllow,
    ]);
  });
});

void describe("ruleKey", () => {
  void it("does not depend on the order of condition keys", () => {
    const a: Rule = {
      tool: "Bash",
      tier: "allow",
      when: { cwd: "./a", branch: "main" },
    };
    const b: Rule = {
      tool: "Bash",
      tier: "allow",
      when: { branch: "main", cwd: "./a" },
    };
    assert.equal(ruleKey(a), ruleKey(b));
  });
});
