/** Actors, roles and approvers: who is acting, and who may resolve an ask. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { check } from "../api.ts";
import { CODECS } from "../compat/codecs.ts";
import { UnsupportedCapabilityError } from "../compat/unsupported.ts";
import {
  collectRules,
  evaluate,
  explain,
  type PermissionPolicy,
} from "../evaluate.ts";
import { AgentPermissionPolicy, type Rule } from "../schema.ts";

const pushAsMaintainer: PermissionPolicy = {
  defaultMode: "restricted",
  rules: [
    {
      tool: "Bash",
      pattern: "git push:*",
      tier: "allow",
      when: { role: "maintainer" },
    },
  ],
};

void describe("when.role", () => {
  void it("applies to an actor who holds the role", () => {
    assert.equal(
      evaluate(pushAsMaintainer, "Bash", "git push origin", {
        actor: "ada",
        roles: ["maintainer", "reviewer"],
      }),
      "allow",
    );
  });

  void it("does not apply to an actor who does not", () => {
    assert.equal(
      evaluate(pushAsMaintainer, "Bash", "git push origin", {
        actor: "bob",
        roles: ["reviewer"],
      }),
      "ask",
    );
  });

  void it("is unknown when the host gives no roles, so an allow does not apply", () => {
    assert.equal(
      evaluate(pushAsMaintainer, "Bash", "git push origin", { actor: "ada" }),
      "ask",
    );
    assert.equal(
      evaluate(pushAsMaintainer, "Bash", "git push origin", {}),
      "ask",
    );
  });

  void it("is unknown when the host gives no roles, so a deny still applies", () => {
    const policy: PermissionPolicy = {
      defaultMode: "autonomous",
      rules: [
        {
          tool: "Bash",
          pattern: "git push:*",
          tier: "deny",
          when: { role: "contractor" },
        },
      ],
    };
    assert.equal(evaluate(policy, "Bash", "git push origin", {}), "deny");
    assert.equal(
      evaluate(policy, "Bash", "git push origin", { roles: ["maintainer"] }),
      "allow",
    );
  });

  void it("an empty role list is known: the actor holds nothing", () => {
    assert.equal(
      evaluate(pushAsMaintainer, "Bash", "git push origin", { roles: [] }),
      "ask",
    );
  });
});

void describe("when.actor", () => {
  const policy: PermissionPolicy = {
    defaultMode: "autonomous",
    rules: [
      {
        tool: "Bash",
        pattern: "deploy:*",
        tier: "deny",
        when: { actor: "contractor-*" },
      },
    ],
  };

  void it("matches the actor as a glob", () => {
    assert.equal(
      evaluate(policy, "Bash", "deploy prod", { actor: "contractor-7" }),
      "deny",
    );
    assert.equal(
      evaluate(policy, "Bash", "deploy prod", { actor: "ada" }),
      "allow",
    );
  });

  void it("is unknown without an actor, so a deny still applies", () => {
    assert.equal(evaluate(policy, "Bash", "deploy prod", {}), "deny");
  });
});

void describe("roles", () => {
  const roles = {
    maintainer: { allow: ["Bash(git push:*)"], ask: ["Bash(npm publish:*)"] },
    contractor: { deny: ["Bash(git push:*)"] },
  };

  void it("write rules that apply to the actors holding the role", () => {
    const rules = collectRules({ roles });
    assert.deepEqual(
      rules
        .map(
          (r) =>
            `${String(r.when?.role)}: ${r.tier} ${r.tool}(${String(r.pattern)})`,
        )
        .sort(),
      [
        "contractor: deny Bash(git push:*)",
        "maintainer: allow Bash(git push:*)",
        "maintainer: ask Bash(npm publish:*)",
      ],
    );
  });

  void it("decide through check", () => {
    const policy = { roles, defaultMode: "restricted" };
    assert.equal(
      check("Bash", "git push origin", policy, { roles: ["maintainer"] })
        .decision,
      "allow",
    );
    assert.equal(
      check("Bash", "git push origin", policy, { roles: ["contractor"] })
        .decision,
      "deny",
    );
    assert.equal(check("Bash", "git push origin", policy, {}).decision, "deny");
  });

  void it("must be named with letters, digits, dots, dashes and underscores", () => {
    assert.equal(
      AgentPermissionPolicy.safeParse({
        roles: { "team*": { allow: ["Read"] } },
      }).success,
      false,
    );
    assert.equal(
      AgentPermissionPolicy.safeParse({
        roles: { "team-a.b_c": { allow: ["Read"] } },
      }).success,
      true,
    );
  });
});

void describe("approvers", () => {
  const ask: Rule = {
    tool: "Bash",
    pattern: "git push:*",
    tier: "ask",
    approvers: {
      roles: ["maintainer"],
      actors: ["ada", "grace"],
      timeoutSeconds: 300,
    },
  };
  const policy: PermissionPolicy = { defaultMode: "autonomous", rules: [ask] };

  void it("are reported on the step that asks", () => {
    const step = explain(policy, "Bash", "git push origin", { actor: "bob" })
      .steps[0];
    assert.equal(step?.decision, "ask");
    assert.deepEqual(step.approvers, {
      roles: ["maintainer"],
      actors: ["ada", "grace"],
      timeoutSeconds: 300,
    });
  });

  void it("never include the requester", () => {
    const step = explain(policy, "Bash", "git push origin", { actor: "ada" })
      .steps[0];
    assert.deepEqual(step?.approvers?.actors, ["grace"]);
  });

  void it("are absent when the rule names none or the decision is not an ask", () => {
    const plain = explain(
      {
        defaultMode: "autonomous",
        rules: [{ tool: "Bash", pattern: "x:*", tier: "ask" }],
      },
      "Bash",
      "x y",
    ).steps[0];
    assert.equal(plain?.approvers, undefined);
    const allowed = explain(policy, "Bash", "ls").steps[0];
    assert.equal(allowed?.approvers, undefined);
  });

  void it("are valid only on an ask rule and must name someone", () => {
    const parse = (rule: object): boolean =>
      AgentPermissionPolicy.safeParse({ rules: [rule] }).success;
    assert.equal(
      parse({ tool: "Bash", tier: "ask", approvers: { roles: ["m"] } }),
      true,
    );
    assert.equal(
      parse({ tool: "Bash", tier: "allow", approvers: { roles: ["m"] } }),
      false,
    );
    assert.equal(
      parse({ tool: "Bash", tier: "deny", approvers: { roles: ["m"] } }),
      false,
    );
    assert.equal(parse({ tool: "Bash", tier: "ask", approvers: {} }), false);
    assert.equal(
      parse({
        tool: "Bash",
        tier: "ask",
        approvers: { roles: ["m"], timeoutSeconds: 0 },
      }),
      false,
    );
  });
});

void describe("principals in codecs", () => {
  const codecs = Object.entries(CODECS);

  void it("refuse a deny or ask rule limited to a role or an actor rather than widening it", () => {
    for (const rule of [
      {
        tool: "Bash",
        pattern: "git push:*",
        tier: "deny",
        when: { role: "contractor" },
      },
      {
        tool: "Bash",
        pattern: "git push:*",
        tier: "ask",
        when: { actor: "bob" },
      },
    ] as const) {
      for (const [name, codec] of codecs) {
        assert.throws(
          () => codec.encode({ rules: [rule] }),
          UnsupportedCapabilityError,
          `${name} ${rule.tier}`,
        );
      }
    }
  });

  void it("refuse a role's deny rule", () => {
    for (const [name, codec] of codecs) {
      assert.throws(
        () => codec.encode({ roles: { contractor: { deny: ["Bash(rm:*)"] } } }),
        UnsupportedCapabilityError,
        name,
      );
    }
  });

  void it("leave out an allow limited to a role, which is stricter", () => {
    const withRole: AgentPermissionPolicy = {
      rules: [
        {
          tool: "Bash",
          pattern: "git push:*",
          tier: "allow",
          when: { role: "maintainer" },
        },
      ],
    };
    const without: AgentPermissionPolicy = {};
    for (const [name, codec] of codecs) {
      assert.deepEqual(codec.encode(withRole), codec.encode(without), name);
    }
  });
});
