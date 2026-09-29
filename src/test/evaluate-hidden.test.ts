/** A `hidden` deny rule: refused like a deny, and its tool left out of the agent's tool list. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CODECS } from "../compat/codecs.ts";
import {
  deduplicateRules,
  evaluate,
  explain,
  isToolVisible,
  visibleTools,
  type PermissionPolicy,
} from "../evaluate.ts";
import { AgentPermissionPolicy, type Rule } from "../schema.ts";

void describe("hidden on a rule", () => {
  void it("is accepted on a deny rule", () => {
    assert.equal(
      AgentPermissionPolicy.safeParse({
        rules: [{ tool: "WebFetch", tier: "deny", hidden: true }],
      }).success,
      true,
    );
  });

  void it("is rejected on an allow or ask rule, where it would mean nothing", () => {
    for (const tier of ["allow", "ask"]) {
      assert.equal(
        AgentPermissionPolicy.safeParse({
          rules: [{ tool: "WebFetch", tier, hidden: true }],
        }).success,
        false,
        tier,
      );
    }
  });

  void it("is rejected when it is not true", () => {
    assert.equal(
      AgentPermissionPolicy.safeParse({
        rules: [{ tool: "WebFetch", tier: "deny", hidden: false }],
      }).success,
      false,
    );
  });
});

void describe("hidden deny rules", () => {
  void it("refuse the call as a plain deny does", () => {
    const policy: PermissionPolicy = {
      defaultMode: "autonomous",
      rules: [{ tool: "Bash", pattern: "sudo:*", tier: "deny", hidden: true }],
    };
    assert.equal(evaluate(policy, "Bash", "sudo ls"), "deny");
    assert.equal(evaluate(policy, "Bash", "ls"), "allow");
  });

  void it("report the call as hidden, and a plain deny is not", () => {
    const hide: Rule = {
      tool: "Bash",
      pattern: "sudo:*",
      tier: "deny",
      hidden: true,
    };
    const explanation = explain(
      { defaultMode: "autonomous", rules: [hide] },
      "Bash",
      "sudo ls",
    );
    assert.equal(explanation.decision, "deny");
    assert.equal(explanation.hidden, true);
    assert.equal(explanation.steps[0]?.rule, hide);
    assert.equal(explanation.steps[0].hidden, true);

    const plain = explain(
      {
        defaultMode: "autonomous",
        rules: [{ tool: "Bash", pattern: "sudo:*", tier: "deny" }],
      },
      "Bash",
      "sudo ls",
    );
    assert.equal(plain.hidden, false);
  });

  void it("are reported even when a plain deny listed earlier matches too", () => {
    const hide: Rule = {
      tool: "Bash",
      pattern: "sudo:*",
      tier: "deny",
      hidden: true,
    };
    const policy: PermissionPolicy = {
      defaultMode: "autonomous",
      rules: [{ tool: "Bash", pattern: "sudo:*", tier: "deny" }, hide],
    };
    const explanation = explain(policy, "Bash", "sudo ls");
    assert.equal(explanation.hidden, true);
    assert.equal(explanation.steps[0]?.rule, hide);
  });

  void it("survive deduplication next to a plain deny with the same pattern", () => {
    const plain: Rule = { tool: "Bash", pattern: "sudo:*", tier: "deny" };
    const hide: Rule = { ...plain, hidden: true };
    assert.deepEqual(deduplicateRules([plain, hide]), [plain, hide]);
  });
});

void describe("tool visibility", () => {
  const policy: PermissionPolicy = {
    defaultMode: "autonomous",
    rules: [
      { tool: "WebFetch", tier: "deny", hidden: true },
      { tool: "mcp__github__*", tier: "deny", hidden: true },
      { tool: "Bash", pattern: "sudo:*", tier: "deny", hidden: true },
      { tool: "Write", tier: "deny" },
    ],
  };

  void it("hides a tool named by a hidden rule with no pattern", () => {
    assert.equal(isToolVisible(policy, "WebFetch"), false);
    assert.equal(isToolVisible(policy, "webfetch"), false);
    assert.equal(isToolVisible(policy, "mcp__github__create_issue"), false);
  });

  void it("leaves a tool visible when only some of its inputs are hidden or it is merely denied", () => {
    assert.equal(isToolVisible(policy, "Bash"), true);
    assert.equal(isToolVisible(policy, "Write"), true);
    assert.equal(isToolVisible(policy, "Read"), true);
  });

  void it("filters a tool list", () => {
    assert.deepEqual(
      visibleTools(policy, ["Bash", "WebFetch", "mcp__github__x", "Read"]),
      ["Bash", "Read"],
    );
  });

  void it("hides a conditional tool when the condition holds or is unknown", () => {
    const conditional: PermissionPolicy = {
      defaultMode: "autonomous",
      rules: [
        {
          tool: "WebFetch",
          tier: "deny",
          hidden: true,
          when: { branch: "main" },
        },
      ],
    };
    assert.equal(
      isToolVisible(conditional, "WebFetch", { branch: "main" }),
      false,
    );
    assert.equal(
      isToolVisible(conditional, "WebFetch", { branch: "dev" }),
      true,
    );
    assert.equal(isToolVisible(conditional, "WebFetch", {}), false);
  });
});

void describe("hidden deny rules in codecs", () => {
  void it("are written as the plain deny they refuse as, by every codec", () => {
    const hidden: AgentPermissionPolicy = {
      rules: [
        { tool: "Read", pattern: "./secrets", tier: "deny", hidden: true },
        {
          tool: "WebFetch",
          pattern: "domain:evil.com",
          tier: "deny",
          hidden: true,
        },
        { tool: "Bash", pattern: "sudo:*", tier: "deny", hidden: true },
      ],
    };
    const plain: AgentPermissionPolicy = {
      rules: [
        { tool: "Read", pattern: "./secrets", tier: "deny" },
        { tool: "WebFetch", pattern: "domain:evil.com", tier: "deny" },
        { tool: "Bash", pattern: "sudo:*", tier: "deny" },
      ],
    };
    for (const [name, codec] of Object.entries(CODECS)) {
      const encode = (policy: AgentPermissionPolicy): unknown => {
        try {
          return codec.encode(policy);
        } catch (e) {
          return e instanceof Error ? e.name : String(e);
        }
      };
      assert.deepEqual(encode(hidden), encode(plain), name);
    }
  });
});
