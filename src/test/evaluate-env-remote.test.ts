/** `when.env` and `when.remote` condition a rule on the environment and the git remote. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluate, type PermissionPolicy } from "../evaluate.ts";

const allowOnCi: PermissionPolicy = {
  defaultMode: "restricted",
  rules: [
    {
      tool: "Bash",
      pattern: "deploy:*",
      tier: "allow",
      when: { env: { CI: "true" } },
    },
  ],
};

void describe("when.env", () => {
  void it("applies when every named variable has the given value", () => {
    assert.equal(
      evaluate(allowOnCi, "Bash", "deploy prod", { env: { CI: "true" } }),
      "allow",
    );
  });

  void it("does not apply when a variable has another value", () => {
    assert.equal(
      evaluate(allowOnCi, "Bash", "deploy prod", { env: { CI: "false" } }),
      "ask",
    );
  });

  void it("is unknown when the variable is unset, so an allow does not apply", () => {
    assert.equal(
      evaluate(allowOnCi, "Bash", "deploy prod", { env: {} }),
      "ask",
    );
    assert.equal(evaluate(allowOnCi, "Bash", "deploy prod", {}), "ask");
  });

  void it("is unknown when unset, so a deny still applies", () => {
    const policy: PermissionPolicy = {
      defaultMode: "autonomous",
      rules: [
        {
          tool: "Bash",
          pattern: "deploy:*",
          tier: "deny",
          when: { env: { CI: "true" } },
        },
      ],
    };
    assert.equal(evaluate(policy, "Bash", "deploy prod", {}), "deny");
    assert.equal(
      evaluate(policy, "Bash", "deploy prod", { env: { CI: "false" } }),
      "allow",
    );
  });

  void it("requires all named variables, and a known mismatch settles it", () => {
    const policy: PermissionPolicy = {
      defaultMode: "restricted",
      rules: [
        {
          tool: "Bash",
          pattern: "deploy:*",
          tier: "deny",
          when: { env: { CI: "true", STAGE: "prod" } },
        },
      ],
    };
    assert.equal(
      evaluate(policy, "Bash", "deploy x", {
        env: { CI: "true", STAGE: "prod" },
      }),
      "deny",
    );
    assert.equal(
      evaluate(policy, "Bash", "deploy x", { env: { CI: "false" } }),
      "ask",
    );
  });
});

void describe("when.remote", () => {
  const onOrg: PermissionPolicy = {
    defaultMode: "restricted",
    rules: [
      {
        tool: "Bash",
        pattern: "git push:*",
        tier: "allow",
        when: { remote: "github.com/exadev/*" },
      },
    ],
  };

  void it("matches the normalised remote whatever form it is written in", () => {
    for (const remote of [
      "git@github.com:ExaDev/agent-perms.git",
      "https://github.com/exadev/agent-perms",
      "ssh://git@github.com/ExaDev/agent-perms.git",
    ]) {
      assert.equal(
        evaluate(onOrg, "Bash", "git push origin", { remote }),
        "allow",
      );
    }
  });

  void it("does not match another owner", () => {
    assert.equal(
      evaluate(onOrg, "Bash", "git push origin", {
        remote: "git@github.com:other/agent-perms.git",
      }),
      "ask",
    );
  });

  void it("is unknown without a remote, so an allow does not apply", () => {
    assert.equal(evaluate(onOrg, "Bash", "git push origin", {}), "ask");
  });
});
