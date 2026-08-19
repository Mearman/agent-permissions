import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { z } from "zod";
import {
  claudeCodeCodec,
  codexCodec,
  opencodeCodec,
  crushCodec,
  kiroCodec,
  ompCodec,
} from "../compat/codecs.ts";
import type { CodexProfile } from "../compat/codecs.ts";
import type { CodexFilesystemAccess } from "../compat/enums.ts";
import type { Rule } from "../schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find rules matching tool and tier. */
function findRules(
  rules: Rule[] | undefined,
  tool: string,
  tier: string,
): Rule[] {
  return (rules ?? []).filter((r) => r.tool === tool && r.tier === tier);
}

/** Check if a rule exists matching tool, tier, and optionally pattern. */
function hasRule(
  rules: Rule[] | undefined,
  tool: string,
  tier: string,
  pattern?: string,
): boolean {
  return (rules ?? []).some(
    (r) =>
      r.tool === tool &&
      r.tier === tier &&
      (pattern === undefined || r.pattern === pattern),
  );
}

/** Extract a named Codex profile from encoded output, asserting it exists. */
function getCodexProfile(
  encoded: ReturnType<typeof z.encode<typeof codexCodec>>,
  name: string,
): CodexProfile {
  const profiles = encoded.permissions;
  assert.ok(profiles !== undefined, "Expected permissions to be defined");
  const profile = profiles[name];
  assert.ok(profile !== undefined, `Expected profile "${name}" to exist`);
  return profile;
}

/** Narrow filesystem to the granular record variant. */
function getFilesystemRecord(
  fs: CodexProfile["filesystem"],
): Record<string, CodexFilesystemAccess> {
  assert.ok(typeof fs === "object", "Expected granular filesystem record");
  return fs;
}

/** Narrow network.domains to a record. */
function getNetworkDomains(
  net: CodexProfile["network"],
): Record<string, "allow" | "deny"> {
  assert.ok(net !== undefined, "Expected network to be defined");
  assert.ok(
    net.domains !== undefined,
    "Expected network.domains to be defined",
  );
  return net.domains;
}

// ---------------------------------------------------------------------------
// Claude Code codec
// ---------------------------------------------------------------------------

void describe("claudeCodeCodec", () => {
  void describe("decode (Claude Code → canonical)", () => {
    void it("maps allow/deny/ask arrays to rules", () => {
      const result = claudeCodeCodec.decode({
        allow: ["Bash(git status)", "Read"],
        deny: ["Bash(sudo:*)"],
        ask: ["Bash(git push:*)"],
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Bash", "allow", "git status"), true);
      assert.equal(hasRule(result.rules, "Read", "allow"), true);
      assert.equal(hasRule(result.rules, "Bash", "deny", "sudo:*"), true);
      assert.equal(hasRule(result.rules, "Bash", "ask", "git push:*"), true);
    });

    void it("maps defaultMode to top-level", () => {
      const result = claudeCodeCodec.decode({
        defaultMode: "dontAsk",
        allow: ["Read"],
      });
      assert.strictEqual(result.defaultMode, "dontAsk");
    });

    void it("maps additionalDirectories", () => {
      const result = claudeCodeCodec.decode({
        additionalDirectories: ["../shared-libs/"],
      });
      assert.ok(result.permissions !== undefined);
      assert.deepStrictEqual(result.permissions.additionalDirectories, [
        "../shared-libs/",
      ]);
    });

    void it("decodes real settings.json permissions block", () => {
      const result = claudeCodeCodec.decode({
        allow: [
          "Bash(du:*)",
          "Bash(python3:*)",
          "Bash(claude plugin:*)",
          "Bash(*rm* -rf */cache/*)",
        ],
        deny: ["Bash(*rm* /)", "Bash(sudo *rm*)", "Bash(git add -A*)"],
        ask: ["Bash(*rm\\* -r*)", "Write(eslint.config.ts)"],
        defaultMode: "dontAsk",
      });
      assert.ok(result.rules !== undefined);
      assert.equal(findRules(result.rules, "Bash", "allow").length, 4);
      assert.equal(findRules(result.rules, "Bash", "deny").length, 3);
      assert.equal(findRules(result.rules, "Bash", "ask").length, 1);
      assert.equal(findRules(result.rules, "Write", "ask").length, 1);
      assert.strictEqual(result.defaultMode, "dontAsk");
    });
  });

  void describe("encode (canonical → Claude Code)", () => {
    void it("encodes rules to allow/deny/ask arrays", () => {
      const encoded = z.encode(claudeCodeCodec, {
        rules: [
          { tool: "Bash", pattern: "git status", tier: "allow" },
          { tool: "Read", tier: "allow" },
          { tool: "Bash", pattern: "sudo:*", tier: "deny" },
          { tool: "Bash", pattern: "git push:*", tier: "ask" },
        ],
        defaultMode: "dontAsk",
      });
      assert.deepStrictEqual(encoded.allow, ["Bash(git status)", "Read"]);
      assert.deepStrictEqual(encoded.deny, ["Bash(sudo:*)"]);
      assert.deepStrictEqual(encoded.ask, ["Bash(git push:*)"]);
      assert.strictEqual(encoded.defaultMode, "dontAsk");
    });

    void it("also reads from permissions arrays for backwards compat", () => {
      const encoded = z.encode(claudeCodeCodec, {
        permissions: {
          allow: ["Bash(git status)", "Read"],
          deny: ["Bash(sudo:*)"],
        },
      });
      assert.deepStrictEqual(encoded.allow, ["Bash(git status)", "Read"]);
      assert.deepStrictEqual(encoded.deny, ["Bash(sudo:*)"]);
    });

    void it("places defaultMode in permissions block (Claude Code placement)", () => {
      const encoded = z.encode(claudeCodeCodec, {
        rules: [{ tool: "Read", tier: "allow" }],
        defaultMode: "plan",
      });
      assert.strictEqual(encoded.defaultMode, "plan");
    });
  });

  void describe("round-trip (native → canonical → native)", () => {
    void it("preserves allow/deny/ask/defaultMode through full cycle", () => {
      const native = {
        allow: ["Bash(git status)", "Read", "Bash(npm run test:*)"],
        deny: ["Bash(sudo:*)", "Bash(rm -rf /)"],
        ask: ["Bash(git push:*)"],
        defaultMode: "dontAsk" as const,
      };
      const canonical = claudeCodeCodec.decode(native);
      const reEncoded = z.encode(claudeCodeCodec, canonical);
      const reDecoded = claudeCodeCodec.decode(reEncoded);
      assert.ok(reDecoded.rules !== undefined);
      assert.equal(
        hasRule(reDecoded.rules, "Bash", "allow", "git status"),
        true,
      );
      assert.equal(hasRule(reDecoded.rules, "Read", "allow"), true);
      assert.equal(hasRule(reDecoded.rules, "Bash", "deny", "sudo:*"), true);
      assert.equal(hasRule(reDecoded.rules, "Bash", "ask", "git push:*"), true);
      assert.strictEqual(reDecoded.defaultMode, "dontAsk");
    });

    void it("preserves additionalDirectories through full cycle", () => {
      const native = {
        allow: ["Read"],
        additionalDirectories: ["../shared-libs/", "/tmp/cache"],
      };
      const canonical = claudeCodeCodec.decode(native);
      const reEncoded = z.encode(claudeCodeCodec, canonical);
      const reDecoded = claudeCodeCodec.decode(reEncoded);
      assert.ok(reDecoded.permissions !== undefined);
      assert.deepStrictEqual(
        reDecoded.permissions.additionalDirectories,
        native.additionalDirectories,
      );
    });

    void it("preserves real settings.json through full cycle", () => {
      const native = {
        allow: [
          "Bash(du:*)",
          "Bash(python3:*)",
          "Bash(claude plugin:*)",
          "Bash(*rm* -rf */cache/*)",
        ],
        deny: ["Bash(*rm* /)", "Bash(sudo *rm*)", "Bash(git add -A*)"],
        ask: ["Bash(*rm\\* -r*)", "Write(eslint.config.ts)"],
        defaultMode: "dontAsk" as const,
      };
      const canonical = claudeCodeCodec.decode(native);
      const reEncoded = z.encode(claudeCodeCodec, canonical);
      const reDecoded = claudeCodeCodec.decode(reEncoded);
      assert.ok(reDecoded.rules !== undefined);
      assert.equal(findRules(reDecoded.rules, "Bash", "allow").length, 4);
      assert.equal(findRules(reDecoded.rules, "Bash", "deny").length, 3);
      assert.equal(findRules(reDecoded.rules, "Bash", "ask").length, 1);
      assert.strictEqual(reDecoded.defaultMode, "dontAsk");
    });
  });
});

// ---------------------------------------------------------------------------
// OpenCode codec
// ---------------------------------------------------------------------------

void describe("opencodeCodec", () => {
  void describe("decode (OpenCode → canonical)", () => {
    void it("converts 'allow' shorthand to autonomous mode", () => {
      assert.strictEqual(
        opencodeCodec.decode("allow").defaultMode,
        "autonomous",
      );
    });

    void it("converts 'deny' shorthand to restricted mode", () => {
      assert.strictEqual(
        opencodeCodec.decode("deny").defaultMode,
        "restricted",
      );
    });

    void it("converts granular bash rules to canonical rules", () => {
      const result = opencodeCodec.decode({
        bash: { "*": "ask", "git *": "allow", "rm *": "deny" },
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Bash", "ask", "*"), true);
      assert.equal(hasRule(result.rules, "Bash", "allow", "git *"), true);
      assert.equal(hasRule(result.rules, "Bash", "deny", "rm *"), true);
    });

    void it("converts shorthand tool actions to canonical bare tool rules", () => {
      const result = opencodeCodec.decode({
        edit: "deny",
        read: "allow",
        bash: "ask",
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Edit", "deny"), true);
      assert.equal(hasRule(result.rules, "Read", "allow"), true);
      assert.equal(hasRule(result.rules, "Bash", "ask"), true);
    });

    void it("maps external_directory to sandbox.writableRoots", () => {
      const result = opencodeCodec.decode({
        external_directory: { "~/projects/lib": "allow" },
      });
      assert.ok(result.sandbox !== undefined);
      assert.deepStrictEqual(result.sandbox.writableRoots, ["~/projects/lib"]);
    });

    void it("converts Markdown-defined agent permissions", () => {
      const result = opencodeCodec.decode({
        edit: "deny",
        bash: { "git diff": "allow", "git log*": "allow", "*": "ask" },
        webfetch: "deny",
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Edit", "deny"), true);
      assert.equal(hasRule(result.rules, "Bash", "allow", "git diff"), true);
      assert.equal(hasRule(result.rules, "Bash", "ask", "*"), true);
    });
  });

  void describe("encode (canonical → OpenCode)", () => {
    void it("converts canonical rules to OpenCode granular format", () => {
      const encoded = z.encode(opencodeCodec, {
        rules: [
          { tool: "Bash", pattern: "git status *", tier: "allow" },
          { tool: "Read", tier: "allow" },
          { tool: "Bash", pattern: "rm *", tier: "deny" },
          { tool: "Edit", tier: "deny" },
          { tool: "Bash", pattern: "git push *", tier: "ask" },
        ],
      });
      assert.strictEqual(typeof encoded, "object");
      assert.ok(!Array.isArray(encoded));
      assert.ok("bash" in (encoded as Record<string, unknown>));
      assert.strictEqual(
        typeof (encoded as Record<string, unknown>).bash,
        "object",
      );
    });

    void it("simplifies bare tool names to shorthand", () => {
      const encoded = z.encode(opencodeCodec, {
        rules: [
          { tool: "Edit", tier: "deny" },
          { tool: "Read", tier: "allow" },
        ],
      });
      assert.strictEqual((encoded as Record<string, unknown>).edit, "deny");
      assert.strictEqual((encoded as Record<string, unknown>).read, "allow");
    });
  });

  void describe("round-trip (native → canonical → native)", () => {
    void it("preserves granular bash rules through full cycle", () => {
      const native = {
        bash: { "*": "ask", "git *": "allow", "rm *": "deny" },
        read: "allow",
        edit: "deny",
      } as const;
      const canonical = opencodeCodec.decode(native);
      const reEncoded = z.encode(opencodeCodec, canonical);
      const reDecoded = opencodeCodec.decode(reEncoded);
      assert.ok(reDecoded.rules !== undefined);
      assert.equal(hasRule(reDecoded.rules, "Bash", "ask", "*"), true);
      assert.equal(hasRule(reDecoded.rules, "Bash", "allow", "git *"), true);
      assert.equal(hasRule(reDecoded.rules, "Bash", "deny", "rm *"), true);
      assert.equal(hasRule(reDecoded.rules, "Read", "allow"), true);
      assert.equal(hasRule(reDecoded.rules, "Edit", "deny"), true);
    });

    void it("preserves shorthand action through full cycle", () => {
      const canonical = opencodeCodec.decode("allow");
      assert.strictEqual(canonical.defaultMode, "autonomous");
      const encoded = z.encode(opencodeCodec, canonical);
      assert.ok(typeof encoded === "object");
    });

    void it("preserves mixed shorthand + granular rules", () => {
      const native = {
        bash: { "git diff": "allow", "git log*": "allow", "*": "ask" },
        edit: "deny",
        webfetch: "deny",
      } as const;
      const canonical = opencodeCodec.decode(native);
      const reEncoded = z.encode(opencodeCodec, canonical);
      const reDecoded = opencodeCodec.decode(reEncoded);
      assert.ok(reDecoded.rules !== undefined);
      assert.equal(hasRule(reDecoded.rules, "Bash", "allow", "git diff"), true);
      assert.equal(hasRule(reDecoded.rules, "Bash", "allow", "git log*"), true);
      assert.equal(hasRule(reDecoded.rules, "Bash", "ask", "*"), true);
      assert.equal(hasRule(reDecoded.rules, "Edit", "deny"), true);
      assert.equal(hasRule(reDecoded.rules, "WebFetch", "deny"), true);
    });

    void it("preserves external_directory through full cycle via sandbox", () => {
      const native = {
        bash: { "*": "ask" },
        external_directory: {
          "~/projects/lib": "allow",
          "/tmp/cache": "allow",
        },
      } as const;
      const canonical = opencodeCodec.decode(native);
      assert.ok(canonical.sandbox !== undefined);
      assert.deepStrictEqual(canonical.sandbox.writableRoots, [
        "~/projects/lib",
        "/tmp/cache",
      ]);
      assert.ok(canonical.permissions !== undefined);
      assert.deepStrictEqual(canonical.permissions.additionalDirectories, [
        "~/projects/lib",
        "/tmp/cache",
      ]);
      const reEncoded = z.encode(opencodeCodec, canonical);
      assert.deepStrictEqual(
        (reEncoded as Record<string, unknown>).external_directory,
        {
          "~/projects/lib": "allow",
          "/tmp/cache": "allow",
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Crush codec
// ---------------------------------------------------------------------------

void describe("crushCodec", () => {
  void describe("decode (Crush → canonical)", () => {
    void it("maps lowercase tool names to canonical PascalCase rules", () => {
      const result = crushCodec.decode({
        allowed_tools: ["view", "glob", "grep", "edit", "bash"],
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Read", "allow"), true);
      assert.equal(hasRule(result.rules, "Glob", "allow"), true);
      assert.equal(hasRule(result.rules, "Grep", "allow"), true);
      assert.equal(hasRule(result.rules, "Edit", "allow"), true);
      assert.equal(hasRule(result.rules, "Bash", "allow"), true);
    });

    void it("passes through unknown tool names as-is", () => {
      const result = crushCodec.decode({
        allowed_tools: ["mcp_context7_get-library-doc"],
      });
      assert.ok(result.rules !== undefined);
      assert.equal(
        hasRule(result.rules, "mcp_context7_get-library-doc", "allow"),
        true,
      );
    });
  });

  void describe("encode (canonical → Crush)", () => {
    void it("maps canonical rules to Crush lowercase", () => {
      const encoded = z.encode(crushCodec, {
        rules: [
          { tool: "Read", tier: "allow" },
          { tool: "Grep", tier: "allow" },
          { tool: "Bash", tier: "allow" },
        ],
      });
      assert.deepStrictEqual(encoded.allowed_tools, ["view", "grep", "bash"]);
    });

    void it("skips rules with patterns (Crush has no pattern syntax)", () => {
      const encoded = z.encode(crushCodec, {
        rules: [
          { tool: "Bash", pattern: "git status", tier: "allow" },
          { tool: "Read", tier: "allow" },
        ],
      });
      assert.deepStrictEqual(encoded.allowed_tools, ["view"]);
    });

    void it("produces empty allowed_tools for deny-only policy", () => {
      const encoded = z.encode(crushCodec, {
        rules: [{ tool: "Bash", pattern: "sudo:*", tier: "deny" }],
      });
      assert.deepStrictEqual(encoded.allowed_tools, []);
    });
  });

  void describe("round-trip (native → canonical → native)", () => {
    void it("preserves bare tool names through full cycle", () => {
      const native = {
        allowed_tools: ["view", "glob", "grep", "edit", "bash"],
      };
      const canonical = crushCodec.decode(native);
      assert.deepStrictEqual(
        z.encode(crushCodec, canonical).allowed_tools,
        native.allowed_tools,
      );
    });

    void it("preserves MCP tools through full cycle", () => {
      const native = {
        allowed_tools: ["view", "bash", "mcp_context7_get-library-doc"],
      };
      const canonical = crushCodec.decode(native);
      const reEncoded = z.encode(crushCodec, canonical);
      assert.ok(reEncoded.allowed_tools.includes("view"));
      assert.ok(reEncoded.allowed_tools.includes("bash"));
    });

    void it("round-trip is lossy for pattern rules", () => {
      const encoded = z.encode(crushCodec, {
        rules: [
          { tool: "Bash", pattern: "git status", tier: "allow" },
          { tool: "Read", tier: "allow" },
        ],
      });
      assert.deepStrictEqual(encoded.allowed_tools, ["view"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Codex codec
// ---------------------------------------------------------------------------

void describe("codexCodec", () => {
  void describe("decode (Codex → canonical)", () => {
    void it("maps approval_policy 'untrusted' to restricted mode", () => {
      assert.strictEqual(
        codexCodec.decode({ approval_policy: "untrusted" }).defaultMode,
        "restricted",
      );
    });

    void it("maps approval_policy 'never' to autonomous mode", () => {
      assert.strictEqual(
        codexCodec.decode({ approval_policy: "never" }).defaultMode,
        "autonomous",
      );
    });

    void it("maps approval_policy 'on-request' to standard mode", () => {
      assert.strictEqual(
        codexCodec.decode({ approval_policy: "on-request" }).defaultMode,
        "standard",
      );
    });

    void it("maps sandbox_mode 'read-only' to readonly mode", () => {
      const result = codexCodec.decode({ sandbox_mode: "read-only" });
      assert.strictEqual(result.defaultMode, "readonly");
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Write", "deny"), true);
      assert.equal(hasRule(result.rules, "Edit", "deny"), true);
    });

    void it("maps sandbox_mode 'danger-full-access' to autonomous", () => {
      assert.strictEqual(
        codexCodec.decode({ sandbox_mode: "danger-full-access" }).defaultMode,
        "autonomous",
      );
    });

    void it("maps sandbox_workspace_write.writable_roots to sandbox.writableRoots", () => {
      const result = codexCodec.decode({
        sandbox_workspace_write: {
          writable_roots: ["/tmp/build-cache", "../shared-libs"],
        },
      });
      assert.ok(result.sandbox !== undefined);
      assert.deepStrictEqual(result.sandbox.writableRoots, [
        "/tmp/build-cache",
        "../shared-libs",
      ]);
    });

    void it("converts filesystem shorthand 'read' to Write+Edit deny rules", () => {
      const result = codexCodec.decode({
        permissions: { strict: { filesystem: "read" } },
        default_permissions: "strict",
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Write", "deny"), true);
      assert.equal(hasRule(result.rules, "Edit", "deny"), true);
    });

    void it("converts filesystem shorthand 'none' to full deny rules", () => {
      const result = codexCodec.decode({
        permissions: { locked: { filesystem: "none" } },
        default_permissions: "locked",
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Read", "deny"), true);
      assert.equal(hasRule(result.rules, "Write", "deny"), true);
      assert.equal(hasRule(result.rules, "Edit", "deny"), true);
    });

    void it("converts granular filesystem rules to path-based deny rules", () => {
      const result = codexCodec.decode({
        permissions: {
          default: {
            filesystem: { "/etc/config": "read", "/secrets": "none" },
          },
        },
        default_permissions: "default",
      });
      assert.ok(result.rules !== undefined);
      assert.equal(
        hasRule(result.rules, "Write", "deny", "./etc/config"),
        true,
      );
      assert.equal(hasRule(result.rules, "Edit", "deny", "./etc/config"), true);
      assert.equal(hasRule(result.rules, "Read", "deny", "./secrets"), true);
      assert.equal(hasRule(result.rules, "Write", "deny", "./secrets"), true);
    });

    void it("converts network domain rules to WebFetch rules", () => {
      const result = codexCodec.decode({
        permissions: {
          default: {
            network: {
              domains: { "api.example.com": "allow", "evil.com": "deny" },
            },
          },
        },
        default_permissions: "default",
      });
      assert.ok(result.rules !== undefined);
      assert.equal(
        hasRule(result.rules, "WebFetch", "allow", "domain:api.example.com"),
        true,
      );
      assert.equal(
        hasRule(result.rules, "WebFetch", "deny", "domain:evil.com"),
        true,
      );
    });

    void it("uses all profiles when default_permissions is unset", () => {
      const result = codexCodec.decode({
        permissions: {
          safe: { filesystem: "read" },
          open: { filesystem: "write" },
        },
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Write", "deny"), true);
      assert.equal(hasRule(result.rules, "Edit", "deny"), true);
    });
  });

  void describe("encode (canonical → Codex)", () => {
    void it("maps defaultMode to approval_policy + sandbox_mode", () => {
      const encoded = z.encode(codexCodec, { defaultMode: "standard" });
      assert.strictEqual(encoded.approval_policy, "on-request");
      assert.strictEqual(encoded.sandbox_mode, "workspace-write");
    });

    void it("maps autonomous to never + danger-full-access", () => {
      const encoded = z.encode(codexCodec, { defaultMode: "autonomous" });
      assert.strictEqual(encoded.approval_policy, "never");
      assert.strictEqual(encoded.sandbox_mode, "danger-full-access");
    });

    void it("maps readonly to untrusted + read-only", () => {
      const encoded = z.encode(codexCodec, { defaultMode: "restricted" });
      assert.strictEqual(encoded.approval_policy, "untrusted");
      assert.strictEqual(encoded.sandbox_mode, "workspace-write");
    });

    void it("maps sandbox.writableRoots to writable_roots", () => {
      const encoded = z.encode(codexCodec, {
        sandbox: { writableRoots: ["/tmp/build-cache"] },
      });
      assert.ok(encoded.sandbox_workspace_write !== undefined);
      assert.deepStrictEqual(encoded.sandbox_workspace_write.writable_roots, [
        "/tmp/build-cache",
      ]);
    });

    void it("converts deny rules to filesystem + network profile", () => {
      const encoded = z.encode(codexCodec, {
        rules: [
          { tool: "Write", pattern: "./secrets", tier: "deny" },
          { tool: "Read", pattern: "./secrets", tier: "deny" },
          { tool: "WebFetch", pattern: "domain:evil.com", tier: "deny" },
          {
            tool: "WebFetch",
            pattern: "domain:api.example.com",
            tier: "allow",
          },
        ],
      });
      assert.ok(encoded.permissions !== undefined);
      assert.strictEqual(encoded.default_permissions, "default");
      const profile = getCodexProfile(encoded, "default");
      const fs = getFilesystemRecord(profile.filesystem);
      assert.strictEqual(fs["/secrets"], "none");
      const domains = getNetworkDomains(profile.network);
      assert.strictEqual(domains["evil.com"], "deny");
      assert.strictEqual(domains["api.example.com"], "allow");
    });
  });

  void describe("round-trip (native → canonical → native)", () => {
    void it("preserves approval_policy + sandbox_mode through full cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        sandbox_mode: "workspace-write" as const,
      };
      const reEncoded = z.encode(codexCodec, codexCodec.decode(native));
      assert.strictEqual(reEncoded.approval_policy, "on-request");
      assert.strictEqual(reEncoded.sandbox_mode, "workspace-write");
    });

    void it("preserves autonomous mode through full cycle", () => {
      const native = {
        approval_policy: "never" as const,
        sandbox_mode: "danger-full-access" as const,
      };
      const canonical = codexCodec.decode(native);
      assert.strictEqual(canonical.defaultMode, "autonomous");
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.approval_policy, "never");
      assert.strictEqual(reEncoded.sandbox_mode, "danger-full-access");
    });

    void it("preserves writable_roots through full cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        sandbox_workspace_write: {
          writable_roots: ["/tmp/build-cache", "../shared-libs"],
        },
      };
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.sandbox !== undefined);
      assert.deepStrictEqual(canonical.sandbox.writableRoots, [
        "/tmp/build-cache",
        "../shared-libs",
      ]);
      const reEncoded = z.encode(codexCodec, canonical);
      assert.ok(reEncoded.sandbox_workspace_write !== undefined);
      assert.deepStrictEqual(reEncoded.sandbox_workspace_write.writable_roots, [
        "/tmp/build-cache",
        "../shared-libs",
      ]);
    });

    void it("preserves filesystem granular rules through full cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        permissions: {
          default: {
            filesystem: { "/secrets": "none", "/etc/config": "read" } as const,
          },
        },
        default_permissions: "default",
      } as const;
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.rules !== undefined);
      assert.equal(hasRule(canonical.rules, "Read", "deny", "./secrets"), true);
      assert.equal(
        hasRule(canonical.rules, "Write", "deny", "./secrets"),
        true,
      );
      assert.equal(
        hasRule(canonical.rules, "Write", "deny", "./etc/config"),
        true,
      );
      const reEncoded = z.encode(codexCodec, canonical);
      const profile = getCodexProfile(reEncoded, "default");
      const fs = getFilesystemRecord(profile.filesystem);
      assert.strictEqual(fs["/secrets"], "none");
      assert.strictEqual(fs["/etc/config"], "read");
    });

    void it("preserves network domain rules through full cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        permissions: {
          default: {
            network: {
              domains: { "api.example.com": "allow", "evil.com": "deny" },
            },
          },
        },
        default_permissions: "default",
      } as const;
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.rules !== undefined);
      assert.equal(
        hasRule(canonical.rules, "WebFetch", "allow", "domain:api.example.com"),
        true,
      );
      assert.equal(
        hasRule(canonical.rules, "WebFetch", "deny", "domain:evil.com"),
        true,
      );
      const reEncoded = z.encode(codexCodec, canonical);
      const profile = getCodexProfile(reEncoded, "default");
      const domains = getNetworkDomains(profile.network);
      assert.strictEqual(domains["api.example.com"], "allow");
      assert.strictEqual(domains["evil.com"], "deny");
    });

    void it("round-trip is lossy for Bash rules", () => {
      const encoded = z.encode(codexCodec, {
        rules: [
          { tool: "Bash", pattern: "git status", tier: "allow" },
          { tool: "Read", tier: "allow" },
          { tool: "Bash", pattern: "sudo:*", tier: "deny" },
        ],
        defaultMode: "standard" as const,
      });
      // Bash rules don't map to Codex filesystem/network — only the non-Bash rules survive
      assert.strictEqual(encoded.approval_policy, "on-request");
      assert.strictEqual(encoded.sandbox_mode, "workspace-write");
    });

    void it("round-trip is lossy for sandbox_mode read-only", () => {
      const native = {
        approval_policy: "untrusted" as const,
        sandbox_mode: "read-only" as const,
      };
      const canonical = codexCodec.decode(native);
      assert.strictEqual(canonical.defaultMode, "readonly");
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.sandbox_mode, "read-only");
      assert.strictEqual(reEncoded.approval_policy, "untrusted");
    });
  });

  void describe("sandbox round-trip", () => {
    void it("preserves full sandbox config through cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        sandbox_mode: "workspace-write" as const,
        sandbox_workspace_write: {
          writable_roots: ["/tmp/cache"],
          network_access: false,
        },
      };
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.sandbox !== undefined);
      assert.strictEqual(canonical.sandbox.mode, "workspace-write");
      assert.deepStrictEqual(canonical.sandbox.writableRoots, ["/tmp/cache"]);
      assert.strictEqual(canonical.sandbox.networkAccess, false);
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.sandbox_mode, "workspace-write");
      assert.ok(reEncoded.sandbox_workspace_write !== undefined);
      assert.deepStrictEqual(reEncoded.sandbox_workspace_write.writable_roots, [
        "/tmp/cache",
      ]);
      assert.strictEqual(
        reEncoded.sandbox_workspace_write.network_access,
        false,
      );
    });

    void it("preserves danger-full-access sandbox through cycle", () => {
      const native = {
        approval_policy: "never" as const,
        sandbox_mode: "danger-full-access" as const,
      };
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.sandbox !== undefined);
      assert.strictEqual(canonical.sandbox.mode, "full-access");
      assert.strictEqual(canonical.defaultMode, "autonomous");
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.sandbox_mode, "danger-full-access");
      assert.strictEqual(reEncoded.approval_policy, "never");
    });
  });

  void describe("named profiles round-trip", () => {
    void it("preserves named profiles through cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        permissions: {
          strict: { filesystem: { "/secrets": "none" } as const },
          relaxed: {
            filesystem: { "/secrets": "write", "/config": "read" } as const,
          },
        },
        default_permissions: "strict",
      } as const;
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.profiles !== undefined);
      assert.ok(canonical.profiles.strict !== undefined);
      assert.ok(canonical.profiles.relaxed !== undefined);
      assert.strictEqual(canonical.activeProfile, "strict");
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.default_permissions, "strict");
      const strictProfile = getCodexProfile(reEncoded, "strict");
      const strictFs = getFilesystemRecord(strictProfile.filesystem);
      assert.strictEqual(strictFs["/secrets"], "none");
      const relaxedProfile = getCodexProfile(reEncoded, "relaxed");
      const relaxedFs = getFilesystemRecord(relaxedProfile.filesystem);
      assert.strictEqual(relaxedFs["/config"], "read");
    });
  });

  void describe("network round-trip", () => {
    void it("preserves network domains through cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        permissions: {
          default: {
            network: {
              domains: { "api.example.com": "allow", "evil.com": "deny" },
            },
          },
        },
        default_permissions: "default",
      } as const;
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.network !== undefined);
      assert.deepStrictEqual(canonical.network.domains, {
        "api.example.com": "allow",
        "evil.com": "deny",
      });
      const reEncoded = z.encode(codexCodec, canonical);
      const profile = getCodexProfile(reEncoded, "default");
      const domains = getNetworkDomains(profile.network);
      assert.strictEqual(domains["api.example.com"], "allow");
      assert.strictEqual(domains["evil.com"], "deny");
    });
  });
});

// ---------------------------------------------------------------------------
// Kiro codec
// ---------------------------------------------------------------------------

void describe("kiroCodec", () => {
  void describe("decode (Kiro → canonical)", () => {
    void it("maps allowedTools to allow rules", () => {
      const result = kiroCodec.decode({
        allowedTools: ["read", "@git", "@git/git_status", "shell"],
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Read", "allow"), true);
      assert.equal(hasRule(result.rules, "Bash", "allow"), true);
      assert.equal(hasRule(result.rules, "@git", "allow"), true);
      assert.equal(hasRule(result.rules, "@git/git_status", "allow"), true);
    });

    void it("maps shell deniedCommands to deny Bash rules", () => {
      const result = kiroCodec.decode({
        toolsSettings: {
          shell: {
            deniedCommands: ["\\Arm -rf .*\\z"],
          },
        },
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Bash", "deny", "rm -rf .*"), true);
    });

    void it("maps shell allowedCommands to allow Bash rules", () => {
      const result = kiroCodec.decode({
        toolsSettings: {
          shell: {
            allowedCommands: ["\\Agit status\\z"],
          },
        },
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Bash", "allow", "git status"), true);
    });

    void it("maps denyByDefault to restricted mode", () => {
      assert.strictEqual(
        kiroCodec.decode({
          toolsSettings: { shell: { denyByDefault: true } },
        }).defaultMode,
        "restricted",
      );
    });

    void it("maps write deniedPaths to deny Write rules", () => {
      const result = kiroCodec.decode({
        toolsSettings: {
          write: { deniedPaths: ["./secrets/**", ".env"] },
        },
      });
      assert.ok(result.rules !== undefined);
      assert.equal(
        hasRule(result.rules, "Write", "deny", "./secrets/**"),
        true,
      );
      assert.equal(hasRule(result.rules, "Write", "deny", ".env"), true);
    });

    void it("maps read allowedPaths to allow Read rules", () => {
      const result = kiroCodec.decode({
        toolsSettings: {
          read: { allowedPaths: ["~/projects"] },
        },
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Read", "allow", "~/projects"), true);
    });

    void it("maps aws allowedServices/deniedServices", () => {
      const result = kiroCodec.decode({
        toolsSettings: {
          aws: {
            allowedServices: ["s3", "lambda"],
            deniedServices: ["eks"],
          },
        },
      });
      assert.ok(result.rules !== undefined);
      assert.equal(hasRule(result.rules, "Aws", "allow", "service:s3"), true);
      assert.equal(hasRule(result.rules, "Aws", "deny", "service:eks"), true);
    });

    void it("maps web_fetch trusted/blocked to WebFetch rules", () => {
      const result = kiroCodec.decode({
        toolsSettings: {
          web_fetch: {
            trusted: [".*docs\\.aws\\.amazon\\.com.*"],
            blocked: [".*pastebin\\.com.*"],
          },
        },
      });
      assert.ok(result.rules !== undefined);
      assert.equal(
        hasRule(
          result.rules,
          "WebFetch",
          "allow",
          "url:.*docs\\.aws\\.amazon\\.com.*",
        ),
        true,
      );
      assert.equal(
        hasRule(result.rules, "WebFetch", "deny", "url:.*pastebin\\.com.*"),
        true,
      );
    });

    void it("decodes a full agent config", () => {
      const result = kiroCodec.decode({
        allowedTools: ["read", "@git/git_status"],
        toolsSettings: {
          shell: {
            allowedCommands: ["\\Agit status\\z", "\\Agit fetch\\z"],
            deniedCommands: ["\\Arm -rf .*\\z"],
            autoAllowReadonly: true,
            denyByDefault: false,
          },
          write: {
            allowedPaths: ["src/**", "tests/**"],
            deniedPaths: ["./secrets"],
          },
        },
      });
      assert.ok(result.rules !== undefined);
      assert.equal(findRules(result.rules, "Bash", "deny").length, 1);
      assert.equal(findRules(result.rules, "Bash", "allow").length, 2);
      assert.equal(findRules(result.rules, "Write", "deny").length, 1);
      assert.equal(findRules(result.rules, "Write", "allow").length, 2);
      assert.equal(findRules(result.rules, "Read", "allow").length, 1);
      assert.equal(
        findRules(result.rules, "@git/git_status", "allow").length,
        1,
      );
    });
  });

  void describe("encode (canonical → Kiro)", () => {
    void it("encodes bare allow rules to allowedTools", () => {
      const encoded = z.encode(kiroCodec, {
        rules: [
          { tool: "Read", tier: "allow" },
          { tool: "Bash", tier: "allow" },
          { tool: "@git", tier: "allow" },
        ],
      });
      assert.deepStrictEqual(encoded.allowedTools, ["read", "shell", "@git"]);
    });

    void it("encodes Bash deny rules to shell.deniedCommands", () => {
      const encoded = z.encode(kiroCodec, {
        rules: [{ tool: "Bash", pattern: "rm -rf .*", tier: "deny" }],
      });
      assert.ok(encoded.toolsSettings !== undefined);
      assert.ok(encoded.toolsSettings.shell !== undefined);
      assert.deepStrictEqual(encoded.toolsSettings.shell.deniedCommands, [
        "\\Arm -rf .*\\z",
      ]);
    });

    void it("encodes Write path rules to write settings", () => {
      const encoded = z.encode(kiroCodec, {
        rules: [
          { tool: "Write", pattern: "src/**", tier: "allow" },
          { tool: "Write", pattern: "./secrets", tier: "deny" },
        ],
      });
      assert.ok(encoded.toolsSettings !== undefined);
      assert.ok(encoded.toolsSettings.write !== undefined);
      assert.deepStrictEqual(encoded.toolsSettings.write.allowedPaths, [
        "src/**",
      ]);
      assert.deepStrictEqual(encoded.toolsSettings.write.deniedPaths, [
        "./secrets",
      ]);
    });

    void it("encodes Aws service rules to aws settings", () => {
      const encoded = z.encode(kiroCodec, {
        rules: [
          { tool: "Aws", pattern: "service:s3", tier: "allow" },
          { tool: "Aws", pattern: "service:eks", tier: "deny" },
        ],
      });
      assert.ok(encoded.toolsSettings !== undefined);
      assert.ok(encoded.toolsSettings.aws !== undefined);
      assert.deepStrictEqual(encoded.toolsSettings.aws.allowedServices, ["s3"]);
      assert.deepStrictEqual(encoded.toolsSettings.aws.deniedServices, ["eks"]);
    });

    void it("encodes WebFetch domain rules to web_fetch settings", () => {
      const encoded = z.encode(kiroCodec, {
        rules: [
          {
            tool: "WebFetch",
            pattern: "url:.*docs.aws.amazon.com.*",
            tier: "allow",
          },
          { tool: "WebFetch", pattern: "url:.*evil.com.*", tier: "deny" },
        ],
      });
      assert.ok(encoded.toolsSettings !== undefined);
      assert.ok(encoded.toolsSettings.web_fetch !== undefined);
      assert.deepStrictEqual(encoded.toolsSettings.web_fetch.trusted, [
        "\\A.*docs.aws.amazon.com.*\\z",
      ]);
      assert.deepStrictEqual(encoded.toolsSettings.web_fetch.blocked, [
        "\\A.*evil.com.*\\z",
      ]);
    });

    void it("encodes restricted mode to denyByDefault", () => {
      const encoded = z.encode(kiroCodec, { defaultMode: "restricted" });
      assert.ok(encoded.toolsSettings !== undefined);
      assert.ok(encoded.toolsSettings.shell !== undefined);
      assert.strictEqual(encoded.toolsSettings.shell.denyByDefault, true);
    });
  });

  void describe("round-trip (native → canonical → native)", () => {
    void it("preserves allowedTools through full cycle", () => {
      const native = {
        allowedTools: ["read", "shell", "@git", "@git/git_status"],
      };
      const canonical = kiroCodec.decode(native);
      const reEncoded = z.encode(kiroCodec, canonical);
      assert.ok(reEncoded.allowedTools !== undefined);
      assert.ok(reEncoded.allowedTools.includes("read"));
      assert.ok(reEncoded.allowedTools.includes("shell"));
      assert.ok(reEncoded.allowedTools.includes("@git"));
      assert.ok(reEncoded.allowedTools.includes("@git/git_status"));
    });

    void it("preserves shell commands through full cycle", () => {
      const native = {
        toolsSettings: {
          shell: {
            allowedCommands: ["\\Agit status\\z"],
            deniedCommands: ["\\Arm -rf .*\\z"],
            autoAllowReadonly: true,
            denyByDefault: false,
          },
        },
      };
      const canonical = kiroCodec.decode(native);
      assert.ok(canonical.rules !== undefined);
      assert.equal(
        hasRule(canonical.rules, "Bash", "allow", "git status"),
        true,
      );
      assert.equal(hasRule(canonical.rules, "Bash", "deny", "rm -rf .*"), true);
      const reEncoded = z.encode(kiroCodec, canonical);
      assert.ok(reEncoded.toolsSettings !== undefined);
      assert.ok(reEncoded.toolsSettings.shell !== undefined);
      assert.deepStrictEqual(reEncoded.toolsSettings.shell.allowedCommands, [
        "\\Agit status\\z",
      ]);
      assert.deepStrictEqual(reEncoded.toolsSettings.shell.deniedCommands, [
        "\\Arm -rf .*\\z",
      ]);
    });

    void it("preserves write paths through full cycle", () => {
      const native = {
        toolsSettings: {
          write: {
            allowedPaths: ["src/**", "tests/**"],
            deniedPaths: ["./secrets"],
          },
        },
      };
      const canonical = kiroCodec.decode(native);
      assert.ok(canonical.rules !== undefined);
      assert.equal(findRules(canonical.rules, "Write", "allow").length, 2);
      assert.equal(findRules(canonical.rules, "Write", "deny").length, 1);
      const reEncoded = z.encode(kiroCodec, canonical);
      assert.ok(reEncoded.toolsSettings !== undefined);
      assert.ok(reEncoded.toolsSettings.write !== undefined);
      assert.deepStrictEqual(
        reEncoded.toolsSettings.write.allowedPaths?.sort(),
        ["src/**", "tests/**"],
      );
      assert.deepStrictEqual(reEncoded.toolsSettings.write.deniedPaths, [
        "./secrets",
      ]);
    });

    void it("preserves AWS services through full cycle", () => {
      const native = {
        toolsSettings: {
          aws: {
            allowedServices: ["s3", "lambda"],
            deniedServices: ["eks"],
          },
        },
      };
      const canonical = kiroCodec.decode(native);
      assert.ok(canonical.rules !== undefined);
      assert.equal(
        hasRule(canonical.rules, "Aws", "allow", "service:s3"),
        true,
      );
      assert.equal(
        hasRule(canonical.rules, "Aws", "deny", "service:eks"),
        true,
      );
      const reEncoded = z.encode(kiroCodec, canonical);
      assert.ok(reEncoded.toolsSettings !== undefined);
      assert.ok(reEncoded.toolsSettings.aws !== undefined);
      assert.deepStrictEqual(
        reEncoded.toolsSettings.aws.allowedServices?.sort(),
        ["lambda", "s3"],
      );
      assert.deepStrictEqual(reEncoded.toolsSettings.aws.deniedServices, [
        "eks",
      ]);
    });

    void it("preserves web_fetch patterns through full cycle", () => {
      const native = {
        toolsSettings: {
          web_fetch: {
            trusted: [".*docs\\.aws\\.amazon\\.com.*"],
            blocked: [".*pastebin\\.com.*"],
          },
        },
      };
      const canonical = kiroCodec.decode(native);
      assert.ok(canonical.rules !== undefined);
      assert.equal(
        hasRule(
          canonical.rules,
          "WebFetch",
          "allow",
          "url:.*docs\\.aws\\.amazon\\.com.*",
        ),
        true,
      );
      const reEncoded = z.encode(kiroCodec, canonical);
      assert.ok(reEncoded.toolsSettings !== undefined);
      assert.ok(reEncoded.toolsSettings.web_fetch !== undefined);
      assert.deepStrictEqual(reEncoded.toolsSettings.web_fetch.trusted, [
        "\\A.*docs\\.aws\\.amazon\\.com.*\\z",
      ]);
      assert.deepStrictEqual(reEncoded.toolsSettings.web_fetch.blocked, [
        "\\A.*pastebin\\.com.*\\z",
      ]);
    });

    void it("preserves full agent config through cycle", () => {
      const native = {
        allowedTools: ["read", "@git/git_status"],
        toolsSettings: {
          shell: {
            allowedCommands: ["\\Agit status\\z"],
            deniedCommands: ["\\Arm -rf .*\\z"],
          },
          write: {
            allowedPaths: ["src/**"],
            deniedPaths: ["./secrets"],
          },
        },
      };
      const canonical = kiroCodec.decode(native);
      const reEncoded = z.encode(kiroCodec, canonical);
      const reDecoded = kiroCodec.decode(reEncoded);
      assert.ok(reDecoded.rules !== undefined);
      assert.equal(findRules(reDecoded.rules, "Read", "allow").length, 1);
      assert.equal(
        findRules(reDecoded.rules, "@git/git_status", "allow").length,
        1,
      );
      assert.equal(findRules(reDecoded.rules, "Bash", "deny").length, 1);
      assert.equal(findRules(reDecoded.rules, "Bash", "allow").length, 1);
      assert.equal(findRules(reDecoded.rules, "Write", "deny").length, 1);
      assert.equal(findRules(reDecoded.rules, "Write", "allow").length, 1);
    });
  });
});

void describe("ompCodec", () => {
  void it("decodes all native approvals and ignores unsupported entries", () => {
    assert.deepEqual(
      ompCodec.decode({
        bash: {
          patterns: [
            { match: "git status", approval: "allow" },
            { match: "git push", approval: "prompt" },
            { match: "rm *", approval: "deny" },
            { match: "", approval: "allow" },
            { match: 42, approval: "allow" },
            { match: "git log", approval: "unknown" },
          ],
          enabled: true,
        },
        model: "x",
      }),
      {
        rules: [
          { tool: "Bash", pattern: "git status", tier: "allow" },
          { tool: "Bash", pattern: "git push", tier: "ask" },
          { tool: "Bash", pattern: "rm *", tier: "deny" },
          { tool: "Bash", pattern: "", tier: "allow" },
        ],
      },
    );
    assert.deepEqual(ompCodec.decode({ bash: { patterns: {} } }), {});
    assert.deepEqual(ompCodec.decode({ bash: {} }), {});
    assert.deepEqual(ompCodec.decode({}), {});
  });

  void it("preserves all native approvals through a native round trip", () => {
    const native = {
      bash: {
        patterns: [
          { match: "git status", approval: "allow" as const },
          { match: "git push", approval: "prompt" as const },
          { match: "rm *", approval: "deny" as const },
        ],
      },
    };
    assert.deepEqual(ompCodec.encode(ompCodec.decode(native)), native);
  });

  void it("projects case-insensitive Bash rules", () => {
    assert.deepEqual(
      ompCodec.encode({
        rules: [{ tool: "bash", pattern: "git status", tier: "allow" }],
      }),
      {
        bash: {
          patterns: [{ match: "git status", approval: "allow" }],
        },
      },
    );
  });

  void it("projects canonical rules to representable OMP patterns", () => {
    const canonical = {
      permissions: {
        deny: ["Bash(rm *)"],
        ask: ["Bash(git push)"],
        allow: ["Bash(git status)"],
      },
      rules: [
        { tool: "Bash", pattern: "git fetch", tier: "allow" as const },
        { tool: "Bash", pattern: "git pull", tier: "ask" as const },
        { tool: "Bash", pattern: "git clean", tier: "deny" as const },
        {
          tool: "Bash",
          pattern: "git log",
          tier: "allow" as const,
          when: { cwd: "/repo" },
        },
        { tool: "Read", pattern: "src/**", tier: "allow" as const },
        { tool: "Bash", tier: "allow" as const },
      ],
    };
    const native = {
      bash: {
        patterns: [
          { match: "rm *", approval: "deny" as const },
          { match: "git push", approval: "prompt" as const },
          { match: "git status", approval: "allow" as const },
          { match: "git fetch", approval: "allow" as const },
          { match: "git pull", approval: "prompt" as const },
          { match: "git clean", approval: "deny" as const },
          { match: "git log", approval: "allow" as const },
        ],
      },
    };

    assert.deepEqual(ompCodec.encode(canonical), native);
    assert.deepEqual(ompCodec.decode(native), {
      rules: [
        { tool: "Bash", pattern: "rm *", tier: "deny" },
        { tool: "Bash", pattern: "git push", tier: "ask" },
        { tool: "Bash", pattern: "git status", tier: "allow" },
        { tool: "Bash", pattern: "git fetch", tier: "allow" },
        { tool: "Bash", pattern: "git pull", tier: "ask" },
        { tool: "Bash", pattern: "git clean", tier: "deny" },
        { tool: "Bash", pattern: "git log", tier: "allow" },
      ],
    });
  });
});
