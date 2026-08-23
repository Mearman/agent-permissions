/** Tests for the deny-first permission evaluator. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluate, type PermissionPolicy } from "../evaluate.ts";

void describe("evaluate", () => {
  void describe("deny-first semantics", () => {
    void it("denies when a deny rule matches, even if allow also matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        rules: [
          { tool: "Bash", pattern: "rm -rf *", tier: "deny" },
          { tool: "Bash", pattern: "*", tier: "allow" },
        ],
      };
      assert.equal(evaluate(policy, "bash", "rm -rf /tmp/thing"), "deny");
    });

    void it("denies when both deny and ask match", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [
          { tool: "Bash", pattern: "curl *", tier: "deny" },
          { tool: "Bash", pattern: "curl *", tier: "ask" },
        ],
      };
      assert.equal(
        evaluate(policy, "bash", "curl https://example.com"),
        "deny",
      );
    });

    void it("asks when ask matches and no deny matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        rules: [{ tool: "Bash", pattern: "curl *", tier: "ask" }],
      };
      assert.equal(evaluate(policy, "bash", "curl https://example.com"), "ask");
    });

    void it("allows when allow matches and no deny/ask matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "ls *", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "ls -la"), "allow");
    });
  });

  void describe("default mode fallback", () => {
    void it("allows in autonomous mode with no matching rules", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        rules: [{ tool: "Edit", pattern: "*", tier: "deny" }],
      };
      assert.equal(evaluate(policy, "bash", "ls"), "allow");
    });

    void it("denies in readonly mode with no matching rules", () => {
      const policy: PermissionPolicy = {
        defaultMode: "readonly",
      };
      assert.equal(evaluate(policy, "bash", "echo hello"), "deny");
    });

    void it("asks in standard mode with no matching rules", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
      };
      assert.equal(evaluate(policy, "bash", "echo hello"), "ask");
    });

    void it("asks in restricted mode with no matching rules", () => {
      const policy: PermissionPolicy = {
        defaultMode: "restricted",
      };
      assert.equal(evaluate(policy, "bash", "echo hello"), "ask");
    });

    void it("falls back to default when no rules exist", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
      };
      assert.equal(evaluate(policy, "bash", "anything"), "allow");
    });

    void it("defaults to ask for standard mode without rules", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
      };
      assert.equal(evaluate(policy, "bash", "anything"), "ask");
    });
  });

  void describe("bare tool name matching (no pattern)", () => {
    void it("matches exact tool name without pattern", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "bash", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "anything"), "allow");
    });

    void it("does not match different tool name", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "bash", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "edit", "/some/file"), "ask");
    });

    void it("matches case-insensitively", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "anything"), "allow");
    });
  });

  void describe("pattern matching — ToolName(pattern)", () => {
    void it("matches tool name with glob pattern against input", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git *", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git commit -m test"), "allow");
    });

    void it("rejects when tool name matches but pattern does not", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git *", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "npm install"), "ask");
    });

    void it("absent pattern matches any input for that tool", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "anything at all"), "allow");
    });
  });

  void describe("domain pattern — domain:example.com", () => {
    void it("matches when input contains the domain", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "domain:evil.com", tier: "deny" }],
      };
      assert.equal(
        evaluate(policy, "bash", "curl https://evil.com/payload"),
        "deny",
      );
    });

    void it("does not match when domain is absent", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "domain:evil.com", tier: "deny" }],
      };
      assert.equal(
        evaluate(policy, "bash", "curl https://safe.com/page"),
        "ask",
      );
    });

    void it("matches domain as substring", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "domain:evil.com", tier: "deny" }],
      };
      assert.equal(evaluate(policy, "bash", "wget sub.evil.com/path"), "deny");
    });
  });

  void describe("prefix pattern — prefix:*", () => {
    void it("matches when input starts with prefix followed by space", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git status"), "allow");
      assert.equal(evaluate(policy, "bash", "git"), "allow");
    });

    void it("does not match when input has different prefix", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "npm:install"), "ask");
    });
  });

  void describe("glob matching in tool names", () => {
    void it("matches MCP tool prefix with wildcard", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "mcp__server__*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "mcp__server__read", ""), "allow");
      assert.equal(evaluate(policy, "mcp__server__write", ""), "allow");
    });
  });

  void describe("multiple rules in same tier", () => {
    void it("checks all deny rules before moving to ask", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        rules: [
          { tool: "Bash", pattern: "rm *", tier: "deny" },
          { tool: "Bash", pattern: "domain:evil.com", tier: "deny" },
          { tool: "Bash", pattern: "*", tier: "allow" },
        ],
      };
      assert.equal(evaluate(policy, "bash", "rm -rf /"), "deny");
      assert.equal(evaluate(policy, "bash", "curl https://evil.com/x"), "deny");
      assert.equal(evaluate(policy, "bash", "ls -la"), "allow");
    });

    void it("checks all ask rules before moving to allow", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        rules: [
          { tool: "Bash", pattern: "curl *", tier: "ask" },
          { tool: "Bash", pattern: "wget *", tier: "ask" },
          { tool: "Bash", pattern: "*", tier: "allow" },
        ],
      };
      assert.equal(evaluate(policy, "bash", "curl https://x.com"), "ask");
      assert.equal(evaluate(policy, "bash", "wget https://x.com"), "ask");
      assert.equal(evaluate(policy, "bash", "ls"), "allow");
    });
  });

  void describe("path-based matching for file tools", () => {
    void it("matches file path patterns", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [
          { tool: "Edit", pattern: "/etc/*", tier: "deny" },
          { tool: "Edit", pattern: "*", tier: "allow" },
        ],
      };
      assert.equal(evaluate(policy, "edit", "/etc/passwd"), "deny");
      assert.equal(evaluate(policy, "edit", "/home/user/file.ts"), "allow");
    });

    void it("matches read tool path patterns", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Read", pattern: "src/*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "read", "src/index.ts"), "allow");
      assert.equal(evaluate(policy, "read", "dist/index.js"), "ask");
    });
  });

  void describe("edge cases", () => {
    void it("handles empty rules array", () => {
      const policy: PermissionPolicy = {
        defaultMode: "autonomous",
        rules: [],
      };
      assert.equal(evaluate(policy, "bash", "anything"), "allow");
    });

    void it("handles no rules field", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
      };
      assert.equal(evaluate(policy, "bash", "anything"), "ask");
    });

    void it("handles special regex characters in patterns", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "+$[]{}", tier: "deny" }],
      };
      // Special chars should be escaped, not treated as regex
      assert.equal(evaluate(policy, "bash", "+$[]{}"), "deny");
    });
  });
});
