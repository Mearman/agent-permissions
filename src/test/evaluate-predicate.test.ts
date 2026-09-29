/** `when.predicate` conditions a rule on a trilean predicate tree over the context, with the same three values as the other conditions. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluate, type PermissionPolicy } from "../evaluate.ts";
import {
  AgentPermissionPolicy as PermissionPolicySchema,
  Rule,
} from "../schema.ts";
import type { PredicateNode } from "trilean/tree";

const field = (key: string) => ({ kind: "reference" as const, key });
const text = (value: string) => ({ kind: "textLiteral" as const, value });

const remoteIs = (value: string): PredicateNode => ({
  kind: "textCompare",
  op: "equals",
  left: field("remote"),
  right: text(value),
});

const eitherRemote: PredicateNode = {
  kind: "or",
  left: remoteIs("github.com/acme/api"),
  right: remoteIs("github.com/acme/web"),
};

const allowDeployOn = (predicate: PredicateNode): PermissionPolicy => ({
  defaultMode: "restricted",
  rules: [
    { tool: "Bash", pattern: "deploy:*", tier: "allow", when: { predicate } },
  ],
});

const denyDeployOn = (predicate: PredicateNode): PermissionPolicy => ({
  defaultMode: "autonomous",
  rules: [
    { tool: "Bash", pattern: "deploy:*", tier: "deny", when: { predicate } },
  ],
});

void describe("when.predicate", () => {
  void describe("an OR of remotes", () => {
    const policy = allowDeployOn(eitherRemote);

    void it("applies when either remote matches", () => {
      for (const remote of [
        "git@github.com:Acme/API.git",
        "https://github.com/acme/web",
      ]) {
        assert.equal(
          evaluate(policy, "Bash", "deploy prod", { remote }),
          "allow",
        );
      }
    });

    void it("does not apply when neither remote matches", () => {
      assert.equal(
        evaluate(policy, "Bash", "deploy prod", {
          remote: "https://github.com/acme/other",
        }),
        "ask",
      );
    });

    void it("is unknown without a remote, so an allow does not apply but a deny does", () => {
      assert.equal(evaluate(policy, "Bash", "deploy prod", {}), "ask");
      assert.equal(
        evaluate(denyDeployOn(eitherRemote), "Bash", "deploy prod", {}),
        "deny",
      );
    });

    void it("lets a definite match settle an OR whose other side is unknown", () => {
      const withEnv: PredicateNode = {
        kind: "or",
        left: remoteIs("github.com/acme/api"),
        right: {
          kind: "textCompare",
          op: "equals",
          left: field("env:STAGE"),
          right: text("prod"),
        },
      };
      assert.equal(
        evaluate(allowDeployOn(withEnv), "Bash", "deploy prod", {
          remote: "github.com/acme/api",
        }),
        "allow",
      );
    });
  });

  void describe("unless a variable has a value", () => {
    const unlessProd: PredicateNode = {
      kind: "not",
      operand: {
        kind: "textCompare",
        op: "equals",
        left: field("env:STAGE"),
        right: text("prod"),
      },
    };

    void it("applies when the variable has another value", () => {
      assert.equal(
        evaluate(allowDeployOn(unlessProd), "Bash", "deploy dev", {
          env: { STAGE: "dev" },
        }),
        "allow",
      );
    });

    void it("does not apply when the variable has that value", () => {
      assert.equal(
        evaluate(allowDeployOn(unlessProd), "Bash", "deploy dev", {
          env: { STAGE: "prod" },
        }),
        "ask",
      );
    });

    void it("is unknown when the variable is unset, so it never grants", () => {
      assert.equal(
        evaluate(allowDeployOn(unlessProd), "Bash", "deploy dev", { env: {} }),
        "ask",
      );
      assert.equal(
        evaluate(denyDeployOn(unlessProd), "Bash", "deploy dev", { env: {} }),
        "deny",
      );
    });
  });

  void describe("roles", () => {
    const isAdmin: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: field("role:admin"),
      right: { kind: "booleanLiteral", value: true },
    };

    void it("holds when the actor has the role and not when the roles are known and lack it", () => {
      const policy = allowDeployOn(isAdmin);
      assert.equal(
        evaluate(policy, "Bash", "deploy prod", { roles: ["admin"] }),
        "allow",
      );
      assert.equal(
        evaluate(policy, "Bash", "deploy prod", { roles: ["dev"] }),
        "ask",
      );
    });

    void it("is unknown when the host reports no roles", () => {
      const negated: PredicateNode = { kind: "not", operand: isAdmin };
      assert.equal(
        evaluate(allowDeployOn(negated), "Bash", "deploy prod", {}),
        "ask",
      );
      assert.equal(
        evaluate(denyDeployOn(negated), "Bash", "deploy prod", {}),
        "deny",
      );
    });
  });

  void it("combines with the other conditions by AND", () => {
    const policy: PermissionPolicy = {
      defaultMode: "restricted",
      rules: [
        {
          tool: "Bash",
          pattern: "deploy:*",
          tier: "allow",
          when: { branch: "main", predicate: eitherRemote },
        },
      ],
    };
    const remote = "github.com/acme/api";
    assert.equal(
      evaluate(policy, "Bash", "deploy x", { branch: "main", remote }),
      "allow",
    );
    assert.equal(
      evaluate(policy, "Bash", "deploy x", { branch: "dev", remote }),
      "ask",
    );
  });

  void it("gives two rules that differ only in their predicate different identities", () => {
    const policy: PermissionPolicy = {
      defaultMode: "restricted",
      rules: [
        {
          tool: "Bash",
          pattern: "deploy:*",
          tier: "allow",
          when: { predicate: remoteIs("a") },
        },
        {
          tool: "Bash",
          pattern: "deploy:*",
          tier: "deny",
          when: { predicate: remoteIs("b") },
        },
      ],
    };
    assert.equal(evaluate(policy, "Bash", "deploy x", { remote: "b" }), "deny");
    assert.equal(
      evaluate(policy, "Bash", "deploy x", { remote: "a" }),
      "allow",
    );
  });

  void it("refuses to evaluate a policy built in code with a node it cannot judge soundly", () => {
    const exists: PredicateNode = {
      kind: "not",
      operand: { kind: "exists", operand: field("env:CI") },
    };
    assert.throws(
      () => evaluate(allowDeployOn(exists), "Bash", "deploy x", {}),
      /exists/,
    );
  });

  void describe("schema", () => {
    void it("accepts a predicate tree", () => {
      const parsed = Rule.safeParse({
        tool: "Bash",
        tier: "allow",
        when: { predicate: eitherRemote },
      });
      assert.equal(parsed.success, true);
    });

    void it("rejects a tree that is not a predicate node", () => {
      const parsed = Rule.safeParse({
        tool: "Bash",
        tier: "allow",
        when: { predicate: { kind: "nonsense" } },
      });
      assert.equal(parsed.success, false);
    });

    void it("rejects nodes that would read an unknown field as absent or empty", () => {
      const exists: PredicateNode = {
        kind: "not",
        operand: { kind: "exists", operand: field("env:CI") },
      };
      const every: PredicateNode = {
        kind: "every",
        collection: "roles",
        item: remoteIs("x"),
      };
      for (const predicate of [exists, every]) {
        const parsed = Rule.safeParse({
          tool: "Bash",
          tier: "allow",
          when: { predicate },
        });
        assert.equal(parsed.success, false);
      }
    });

    void it("parses inside a whole policy", () => {
      const parsed = PermissionPolicySchema.safeParse({
        rules: [
          { tool: "Bash", tier: "allow", when: { predicate: eitherRemote } },
        ],
      });
      assert.equal(parsed.success, true);
    });
  });
});
