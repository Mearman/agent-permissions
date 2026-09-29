/** A `when` condition on a field the evaluation context does not carry is unknown, not satisfied. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluate, type PermissionPolicy } from "../evaluate.ts";

void describe("conditions on an unknown context field", () => {
  void it("does not let a conditional allow rule apply when the field is missing", () => {
    const policy: PermissionPolicy = {
      defaultMode: "restricted",
      rules: [
        {
          tool: "Bash",
          pattern: "npm run *",
          tier: "allow",
          when: { cwd: "./packages/*" },
        },
      ],
    };
    assert.equal(evaluate(policy, "bash", "npm run build", {}), "ask");
    assert.equal(
      evaluate(policy, "bash", "npm run build", { branch: "main" }),
      "ask",
    );
    assert.equal(
      evaluate(policy, "bash", "npm run build", { cwd: "./packages/a" }),
      "allow",
    );
  });

  void it("still applies a conditional deny rule when the field is missing", () => {
    const policy: PermissionPolicy = {
      defaultMode: "autonomous",
      rules: [
        {
          tool: "Bash",
          pattern: "npm publish:*",
          tier: "deny",
          when: { branch: "main" },
        },
      ],
    };
    assert.equal(evaluate(policy, "bash", "npm publish --tag x", {}), "deny");
    assert.equal(
      evaluate(policy, "bash", "npm publish --tag x", { branch: "dev" }),
      "allow",
    );
  });

  void it("still applies a conditional ask rule when the field is missing", () => {
    const policy: PermissionPolicy = {
      defaultMode: "autonomous",
      rules: [
        {
          tool: "Write",
          pattern: "./config/**",
          tier: "ask",
          when: { branch: "main" },
        },
      ],
    };
    assert.equal(evaluate(policy, "write", "./config/app.yaml", {}), "ask");
  });

  void it("lets a known mismatch settle the rule even if another condition is unknown", () => {
    const policy: PermissionPolicy = {
      defaultMode: "autonomous",
      rules: [
        {
          tool: "Bash",
          pattern: "npm publish:*",
          tier: "deny",
          when: { cwd: "./packages/core", branch: "main" },
        },
      ],
    };
    assert.equal(
      evaluate(policy, "bash", "npm publish", { cwd: "./packages/utils" }),
      "allow",
    );
  });

  void it("does not let a known match satisfy an allow rule while another condition is unknown", () => {
    const policy: PermissionPolicy = {
      defaultMode: "restricted",
      rules: [
        {
          tool: "Bash",
          pattern: "npm run *",
          tier: "allow",
          when: { cwd: "./packages/*", branch: "main" },
        },
      ],
    };
    assert.equal(
      evaluate(policy, "bash", "npm run build", { cwd: "./packages/a" }),
      "ask",
    );
  });
});
