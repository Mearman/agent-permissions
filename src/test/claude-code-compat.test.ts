import { describe, it, expect } from "vitest";
import { agentPermissionPolicy } from "../schema.ts";

/**
 * Compatibility tests: verify that real Claude Code `.claude/settings.json`
 * permission rules parse against our schema.
 *
 * Source: Claude Code's PermissionRuleSchema (permissionValidation.ts),
 * permissionRuleValueFromString (permissionRuleParser.ts), and
 * PermissionsSchema (settings/types.ts).
 *
 * These tests prove zero-translation migration: `jq '.permissions'
 * .claude/settings.json > .agents/permissions.json` produces valid input.
 */
describe("Claude Code compatibility", () => {
  describe("real settings.json permissions", () => {
    it("accepts the full permissions block from a real .claude/settings.json", () => {
      const result = agentPermissionPolicy.safeParse({
        permissions: {
          allow: [
            "Bash(du:*)",
            "Bash(python3:*)",
            "Bash(claude plugin:*)",
            "Bash(*rm* -rf */cache/*)",
            "Bash(*rm* -rf */cache)",
          ],
          deny: [
            "Bash(*rm* /)",
            "Bash(*rm* --no-preserve-root*)",
            "Bash(sudo *rm*)",
            "Bash(git add -A*)",
            "Bash(git add . *)",
          ],
          ask: [
            "Bash(*rm\\* -r*)",
            "Bash(rm \\*)",
            "Bash(rm -f \\*)",
            "Write(eslint.config.ts)",
            "Edit(eslint.config.ts)",
            "Bash(git commit.*--no-verify)",
          ],
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts a real .claude/settings.local.json permissions block", () => {
      const result = agentPermissionPolicy.safeParse({
        permissions: {
          allow: [
            "Bash(du:*)",
            "Bash(python3:*)",
            "Bash(claude plugin:*)",
            "Bash(kill:*)",
            "Bash(find:*)",
            "WebSearch",
            "WebFetch(domain:martinalderson.com)",
            "WebFetch(domain:yuanchang.org)",
            "Bash(brew uninstall:*)",
          ],
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("plain tool names (no parentheses)", () => {
    it.each([
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Grep",
      "WebSearch",
      "WebFetch",
      "Agent",
    ])("accepts '%s' as a bare tool name", (rule) => {
      const result = agentPermissionPolicy.safeParse({
        permissions: { allow: [rule] },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("Bash rules — prefix :* syntax (legacy)", () => {
    it.each([
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(python3:*)",
      "Bash(brew uninstall:*)",
      "Bash(kill:*)",
      "Bash(find:*)",
      "Bash(du:*)",
      "Bash(claude plugin:*)",
    ])("accepts '%s'", (rule) => {
      const result = agentPermissionPolicy.safeParse({
        permissions: { allow: [rule] },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("Bash rules — wildcard patterns", () => {
    it.each([
      "Bash(npm run *)",
      "Bash(*rm* -rf */cache/*)",
      "Bash(*rm* /)",
      "Bash(sudo *rm*)",
      "Bash(git add -A*)",
      "Bash(git add . *)",
      "Bash(git commit.*--no-verify)",
    ])("accepts '%s'", (rule) => {
      const result = agentPermissionPolicy.safeParse({
        permissions: { deny: [rule] },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("Bash rules — escaped characters", () => {
    it.each([
      "Bash(*rm\\* -r*)",
      "Bash(rm \\*)",
      "Bash(rm -f \\*)",
      'Bash(python -c "print\\(1\\)")',
    ])("accepts '%s'", (rule) => {
      const result = agentPermissionPolicy.safeParse({
        permissions: { ask: [rule] },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("file tool rules — path patterns", () => {
    it.each([
      "Read(./.env)",
      "Read(./secrets/**)",
      "Write(eslint.config.ts)",
      "Write(./production/**)",
      "Edit(eslint.config.ts)",
      "Edit(eslint.base.config.ts)",
      "Write(./config/**)",
    ])("accepts '%s'", (rule) => {
      const result = agentPermissionPolicy.safeParse({
        permissions: { deny: [rule] },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("WebFetch rules — domain patterns", () => {
    it.each([
      "WebFetch(domain:example.com)",
      "WebFetch(domain:docs.example.com)",
      "WebFetch(domain:martinalderson.com)",
    ])("accepts '%s'", (rule) => {
      const result = agentPermissionPolicy.safeParse({
        permissions: { allow: [rule] },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("MCP rules", () => {
    it.each([
      "mcp__github",
      "mcp__github__*",
      "mcp__github__create_issue",
      "mcp__filesystem__read_file",
    ])("accepts '%s'", (rule) => {
      const result = agentPermissionPolicy.safeParse({
        permissions: { allow: [rule] },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("defaultMode — Claude Code's mode values", () => {
    it("accepts 'plan' (Claude Code plan mode)", () => {
      expect(
        agentPermissionPolicy.safeParse({
          defaultMode: "plan",
        }).success,
      ).toBe(true);
    });

    it("accepts 'dontAsk' (Claude Code auto-approve mode)", () => {
      expect(
        agentPermissionPolicy.safeParse({
          defaultMode: "dontAsk",
        }).success,
      ).toBe(true);
    });

    it("accepts 'acceptEdits'", () => {
      expect(
        agentPermissionPolicy.safeParse({
          defaultMode: "acceptEdits",
        }).success,
      ).toBe(true);
    });

    it("accepts 'bypassPermissions'", () => {
      expect(
        agentPermissionPolicy.safeParse({
          defaultMode: "bypassPermissions",
        }).success,
      ).toBe(true);
    });

    it("accepts 'default'", () => {
      expect(
        agentPermissionPolicy.safeParse({
          defaultMode: "default",
        }).success,
      ).toBe(true);
    });
  });

  describe("additionalDirectories", () => {
    it("accepts relative and absolute paths", () => {
      const result = agentPermissionPolicy.safeParse({
        permissions: {
          additionalDirectories: ["../shared-libs/", "/tmp/build-cache"],
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("env block (Claude Code compatibility)", () => {
    it("accepts the same env structure as .claude/settings.json", () => {
      const result = agentPermissionPolicy.safeParse({
        env: {
          NODE_ENV: "development",
          DISABLE_TELEMETRY: "1",
          CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("top-level defaultMode vs Claude Code permissions.defaultMode", () => {
    it("accepts defaultMode at the top level (our format)", () => {
      expect(
        agentPermissionPolicy.safeParse({
          defaultMode: "standard",
        }).success,
      ).toBe(true);
    });

    it("accepts defaultMode inside permissions (Claude Code's placement)", () => {
      // Claude Code puts defaultMode inside the permissions object.
      // Our schema accepts it in both positions for zero-translation migration.
      expect(
        agentPermissionPolicy.safeParse({
          permissions: {
            allow: ["Read"],
            defaultMode: "dontAsk",
          },
        }).success,
      ).toBe(true);
    });
  });

  describe("migration: jq '.permissions' produces valid input", () => {
    it("accepts the exact output of extracting Claude Code's permissions block", () => {
      // This simulates: jq '.permissions' .claude/settings.json > .agents/permissions.json
      // No translation needed — defaultMode inside permissions is accepted.
      const claudeCodePermissions = {
        allow: [
          "Bash(du:*)",
          "Bash(python3:*)",
          "Read",
          "Grep",
          "WebSearch",
        ],
        deny: [
          "Bash(*rm* /)",
          "Bash(sudo *rm*)",
          "Read(./.env)",
        ],
        ask: [
          "Bash(git push:*)",
          "Write(eslint.config.ts)",
        ],
        defaultMode: "dontAsk",
      };

      const result = agentPermissionPolicy.safeParse({
        permissions: claudeCodePermissions,
      });
      expect(result.success).toBe(true);
    });
  });
});
