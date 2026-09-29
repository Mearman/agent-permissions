/** The Codex codec either represents a restrictive rule faithfully or refuses to convert it. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { codexCodec } from "../compat/codecs.ts";
import { UnsupportedCapabilityError } from "../compat/unsupported.ts";
import type { AgentPermissionPolicy, Rule } from "../schema.ts";

function encode(policy: AgentPermissionPolicy): unknown {
  return codexCodec.encode(policy);
}

function refusal(policy: AgentPermissionPolicy): UnsupportedCapabilityError {
  try {
    encode(policy);
  } catch (e) {
    assert.ok(e instanceof UnsupportedCapabilityError, String(e));
    return e;
  }
  throw new assert.AssertionError({ message: "expected the encode to throw" });
}

void describe("codex codec refuses rules it cannot enforce", () => {
  void it("refuses a command deny rule instead of dropping it", () => {
    const rule: Rule = { tool: "Bash", pattern: "git push:*", tier: "deny" };
    const error = refusal({ rules: [rule] });
    assert.equal(error.agent, "codex");
    assert.deepEqual(
      error.unsupported.map((u) => u.rule),
      [rule],
    );
  });

  void it("refuses a command ask rule", () => {
    const rule: Rule = { tool: "Bash", pattern: "git push:*", tier: "ask" };
    assert.deepEqual(
      refusal({ rules: [rule] }).unsupported.map((u) => u.rule),
      [rule],
    );
  });

  void it("refuses a deny rule for a tool it has no equivalent of", () => {
    const rule: Rule = { tool: "mcp__github__create_issue", tier: "deny" };
    assert.deepEqual(
      refusal({ rules: [rule] }).unsupported.map((u) => u.rule),
      [rule],
    );
  });

  void it("refuses an ask rule on a path, which Codex can only allow, read or deny", () => {
    const rule: Rule = { tool: "Write", pattern: "./src/**", tier: "ask" };
    assert.equal(refusal({ rules: [rule] }).unsupported.length, 1);
  });

  void it("refuses an ask rule on a domain, which Codex can only allow or deny", () => {
    const rule: Rule = {
      tool: "WebFetch",
      pattern: "domain:example.com",
      tier: "ask",
    };
    assert.equal(refusal({ rules: [rule] }).unsupported.length, 1);
  });

  void it("refuses a tool-wide file deny, which Codex only takes per path", () => {
    assert.equal(
      refusal({ rules: [{ tool: "Write", tier: "deny" }] }).unsupported.length,
      1,
    );
  });

  void it("refuses an otherwise representable deny rule that carries a condition", () => {
    const rule: Rule = {
      tool: "Read",
      pattern: "./secrets/**",
      tier: "deny",
      when: { branch: "main" },
    };
    assert.deepEqual(
      refusal({ rules: [rule] }).unsupported.map((u) => u.rule),
      [rule],
    );
  });

  void it("lists every refused rule, not only the first", () => {
    const rules: Rule[] = [
      { tool: "Bash", pattern: "rm:*", tier: "deny" },
      { tool: "Read", pattern: "./ok", tier: "deny" },
      { tool: "Bash", pattern: "git push:*", tier: "ask" },
    ];
    const error = refusal({ rules });
    assert.deepEqual(
      error.unsupported.map((u) => u.rule),
      [rules[0], rules[2]],
    );
    assert.ok(error.message.includes("Bash(rm:*)"));
    assert.ok(error.message.includes("Bash(git push:*)"));
  });

  void it("refuses a rule inside a named profile and names the profile", () => {
    const error = refusal({
      profiles: { strict: { deny: ["Bash(rm:*)"] } },
      activeProfile: "strict",
    });
    assert.equal(error.unsupported.length, 1);
    assert.ok(error.unsupported[0]?.reason.includes("strict"));
  });

  void it("refuses through the zod encode as well", () => {
    assert.throws(
      () =>
        z.encode(codexCodec, {
          rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
        }),
      UnsupportedCapabilityError,
    );
  });
});

void describe("codex codec still converts what it can enforce", () => {
  void it("keeps a path deny as filesystem access", () => {
    const encoded = encode({
      rules: [
        { tool: "Read", pattern: "./secrets", tier: "deny" },
        { tool: "Write", pattern: "./dist", tier: "deny" },
      ],
    });
    assert.deepEqual(encoded, {
      permissions: {
        default: { filesystem: { "/secrets": "none", "/dist": "read" } },
      },
      default_permissions: "default",
    });
  });

  void it("keeps a domain deny and allow", () => {
    const encoded = encode({
      rules: [
        { tool: "WebFetch", pattern: "domain:evil.com", tier: "deny" },
        { tool: "WebFetch", pattern: "domain:good.com", tier: "allow" },
      ],
    });
    assert.deepEqual(encoded, {
      permissions: {
        default: {
          network: { domains: { "evil.com": "deny", "good.com": "allow" } },
        },
      },
      default_permissions: "default",
    });
  });

  void it("drops an allow rule, since fewer allows can only be stricter", () => {
    assert.deepEqual(
      encode({ rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }] }),
      {},
    );
  });

  void it("keeps a top-level path deny in every named profile", () => {
    const encoded = encode({
      rules: [{ tool: "Read", pattern: "./secrets", tier: "deny" }],
      profiles: { dev: { allow: ["WebFetch(domain:good.com)"] } },
      activeProfile: "dev",
    });
    assert.deepEqual(encoded, {
      permissions: {
        dev: {
          filesystem: { "/secrets": "none" },
          network: { domains: { "good.com": "allow" } },
        },
      },
      default_permissions: "dev",
    });
  });
});
