import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { AgentPermissionPolicy } from "../schema.ts";

void describe("Claude Code compatibility", () => {
  void describe("real settings.json permissions", () => {
    void it("accepts the full permissions block from a real .claude/settings.json", () => {
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

    void it("accepts a real .claude/settings.local.json permissions block", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          permissions: { allow: ["Bash(git push:*)"] },
        }).success,
      );
    });
  });

  void describe("plain tool names (no parentheses)", () => {
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
      void it(`accepts '${tool}' as a bare tool name`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { allow: [tool] },
          }).success,
        );
      });
    }
  });

  void describe("Bash rules — prefix :* syntax (legacy)", () => {
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
      void it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { allow: [rule] },
          }).success,
        );
      });
    }
  });

  void describe("Bash rules — wildcard patterns", () => {
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
      void it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { deny: [rule] },
          }).success,
        );
      });
    }
  });

  void describe("Bash rules — escaped characters", () => {
    const escapedRules = [
      "Bash(*rm\\* -r*)",
      "Bash(rm \\*)",
      "Bash(rm -f \\*)",
      'Bash(python -c "print\\(1\\)")',
    ];

    for (const rule of escapedRules) {
      void it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { ask: [rule] },
          }).success,
        );
      });
    }
  });

  void describe("file tool rules — path patterns", () => {
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
      void it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { deny: [rule] },
          }).success,
        );
      });
    }
  });

  void describe("WebFetch rules — domain patterns", () => {
    const domainRules = [
      "WebFetch(domain:example.com)",
      "WebFetch(domain:docs.example.com)",
      "WebFetch(domain:martinalderson.com)",
    ];

    for (const rule of domainRules) {
      void it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { allow: [rule] },
          }).success,
        );
      });
    }
  });

  void describe("MCP rules", () => {
    const mcpRules = [
      "mcp__github",
      "mcp__github__*",
      "mcp__github__create_issue",
      "mcp__filesystem__read_file",
    ];

    for (const rule of mcpRules) {
      void it(`accepts '${rule}'`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({
            permissions: { allow: [rule] },
          }).success,
        );
      });
    }
  });

  void describe("defaultMode — Claude Code's mode values", () => {
    const claudeModes = [
      "plan",
      "dontAsk",
      "acceptEdits",
      "bypassPermissions",
      "default",
    ];

    for (const mode of claudeModes) {
      void it(`accepts '${mode}' (Claude Code mode)`, () => {
        assert.ok(
          AgentPermissionPolicy.safeParse({ defaultMode: mode }).success,
        );
      });
    }
  });

  void describe("additionalDirectories", () => {
    void it("accepts relative and absolute paths", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          permissions: {
            additionalDirectories: ["../shared-libs/", "/tmp/build-cache"],
          },
        }).success,
      );
    });
  });

  void describe("env block (Claude Code compatibility)", () => {
    void it("accepts the same env structure as .claude/settings.json", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({ env: { FOO: "bar", BAZ: "qux" } })
          .success,
      );
    });
  });

  void describe("top-level defaultMode vs Claude Code permissions.defaultMode", () => {
    void it("accepts defaultMode at the top level (our format)", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          defaultMode: "standard",
          permissions: { allow: ["Read"] },
        }).success,
      );
    });

    void it("accepts defaultMode inside permissions (Claude Code's placement)", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          permissions: { allow: ["Read"], defaultMode: "plan" },
        }).success,
      );
    });
  });

  void describe("migration: jq '.permissions' produces valid input", () => {
    void it("accepts the exact output of extracting Claude Code's permissions block", () => {
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
