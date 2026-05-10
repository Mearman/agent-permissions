import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { AgentPermissionPolicy } from "../schema.ts";

describe("Claude Code compatibility", () => {
  describe("real settings.json permissions", () => {
    it("accepts the full permissions block from a real .claude/settings.json", () => {
      const result = AgentPermissionPolicy.safeParse({
        permissions: {
          allow: [
            "Bash(du:*)",
            "Bash(python3:*)",
            "Bash(claude plugin:*)",
            "Bash(*rm* -rf */cache/*)",
          ],
          deny: ["Bash(*rm* /)", "Bash(sudo *rm*)", "Bash(git add -A*)"],
          ask: ["Bash(*rm\\* -r*)", "Write(eslint.config.ts)"],
          defaultMode: "dontAsk",
        },
      });
      assert.ok(result.success);
    });

    it("accepts a real .claude/settings.local.json permissions block", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          permissions: { allow: ["Bash(git push:*)"] },
        }).success,
      );
    });
  });

  describe("plain tool names (no parentheses)", () => {
    const bareTools = [
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Grep",
      "WebSearch",
      "WebFetch",
      "Agent",
    ];

    for (const tool of bareTools) {
      it(`accepts '${tool}' as a bare tool name`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { allow: [tool] },
          }).success,
        );
      });
    }
  });

  describe("Bash rules — prefix :* syntax (legacy)", () => {
    const prefixRules = [
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(python3:*)",
      "Bash(brew uninstall:*)",
      "Bash(kill:*)",
      "Bash(find:*)",
      "Bash(du:*)",
      "Bash(claude plugin:*)",
    ];

    for (const rule of prefixRules) {
      it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { allow: [rule] },
          }).success,
        );
      });
    }
  });

  describe("Bash rules — wildcard patterns", () => {
    const wildcardRules = [
      "Bash(npm run *)",
      "Bash(*rm* -rf */cache/*)",
      "Bash(*rm* /)",
      "Bash(sudo *rm*)",
      "Bash(git add -A*)",
      "Bash(git add . *)",
      "Bash(git commit.*--no-verify)",
    ];

    for (const rule of wildcardRules) {
      it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { deny: [rule] },
          }).success,
        );
      });
    }
  });

  describe("Bash rules — escaped characters", () => {
    const escapedRules = [
      "Bash(*rm\\* -r*)",
      "Bash(rm \\*)",
      "Bash(rm -f \\*)",
      'Bash(python -c "print\\(1\\)")',
    ];

    for (const rule of escapedRules) {
      it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { ask: [rule] },
          }).success,
        );
      });
    }
  });

  describe("file tool rules — path patterns", () => {
    const pathRules = [
      "Read(./.env)",
      "Read(./secrets/**)",
      "Write(eslint.config.ts)",
      "Write(./production/**)",
      "Edit(eslint.config.ts)",
      "Edit(eslint.base.config.ts)",
      "Write(./config/**)",
    ];

    for (const rule of pathRules) {
      it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { deny: [rule] },
          }).success,
        );
      });
    }
  });

  describe("WebFetch rules — domain patterns", () => {
    const domainRules = [
      "WebFetch(domain:example.com)",
      "WebFetch(domain:docs.example.com)",
      "WebFetch(domain:martinalderson.com)",
    ];

    for (const rule of domainRules) {
      it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { allow: [rule] },
          }).success,
        );
      });
    }
  });

  describe("MCP rules", () => {
    const mcpRules = [
      "mcp__github",
      "mcp__github__*",
      "mcp__github__create_issue",
      "mcp__filesystem__read_file",
    ];

    for (const rule of mcpRules) {
      it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { allow: [rule] },
          }).success,
        );
      });
    }
  });

  describe("defaultMode — Claude Code's mode values", () => {
    const claudeModes = [
      "plan",
      "dontAsk",
      "acceptEdits",
      "bypassPermissions",
      "default",
    ];

    for (const mode of claudeModes) {
      it(`accepts '${mode}' (Claude Code mode)`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({ defaultMode: mode }).success,
        );
      });
    }
  });

  describe("additionalDirectories", () => {
    it("accepts relative and absolute paths", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          permissions: {
            additionalDirectories: ["../shared-libs/", "/tmp/build-cache"],
          },
        }).success,
      );
    });
  });

  describe("env block (Claude Code compatibility)", () => {
    it("accepts the same env structure as .claude/settings.json", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({ env: { FOO: "bar", BAZ: "qux" } })
          .success,
      );
    });
  });

  describe("top-level defaultMode vs Claude Code permissions.defaultMode", () => {
    it("accepts defaultMode at the top level (our format)", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          defaultMode: "standard",
          permissions: { allow: ["Read"] },
        }).success,
      );
    });

    it("accepts defaultMode inside permissions (Claude Code's placement)", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          permissions: { allow: ["Read"], defaultMode: "plan" },
        }).success,
      );
    });
  });

  describe("migration: jq '.permissions' produces valid input", () => {
    it("accepts the exact output of extracting Claude Code's permissions block", () => {
      // This is what `jq '.permissions' .claude/settings.json` produces —
      // pass it as the permissions value, not the top-level policy
      assert.ok(
        AgentPermissionPolicy.safeParse({
          permissions: {
            allow: ["Bash(git status)", "Read"],
            deny: ["Bash(sudo:*)"],
            defaultMode: "dontAsk",
          },
        }).success,
      );
    });
  });
});
