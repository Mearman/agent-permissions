import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { z } from "zod";
import {
  claudeCodeCodec,
  codexCodec,
  opencodeCodec,
  crushCodec,
} from "../compat/codecs.ts";
import type { CodexProfile } from "../compat/codecs.ts";
import type { CodexFilesystemAccess } from "../compat/enums.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a named Codex profile from encoded output, asserting it exists. */
function getCodexProfile(
  encoded: ReturnType<typeof z.encode<typeof codexCodec>>,
  name: string,
): CodexProfile {
  const profiles = encoded.permissions;
  assert.ok(profiles !== undefined, `Expected permissions to be defined`);
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

describe("claudeCodeCodec", () => {
  describe("decode (Claude Code → canonical)", () => {
    it("maps allow/deny/ask arrays directly", () => {
      const result = claudeCodeCodec.decode({
        allow: ["Bash(git status)", "Read"],
        deny: ["Bash(sudo:*)"],
        ask: ["Bash(git push:*)"],
      });
      assert.ok(result.permissions !== undefined);
      assert.deepStrictEqual(result.permissions.allow, [
        "Bash(git status)",
        "Read",
      ]);
      assert.deepStrictEqual(result.permissions.deny, ["Bash(sudo:*)"]);
      assert.deepStrictEqual(result.permissions.ask, ["Bash(git push:*)"]);
    });

    it("maps defaultMode to top-level", () => {
      const result = claudeCodeCodec.decode({
        defaultMode: "dontAsk",
        allow: ["Read"],
      });
      assert.strictEqual(result.defaultMode, "dontAsk");
    });

    it("maps additionalDirectories", () => {
      const result = claudeCodeCodec.decode({
        additionalDirectories: ["../shared-libs/"],
      });
      assert.ok(result.permissions !== undefined);
      assert.deepStrictEqual(result.permissions.additionalDirectories, [
        "../shared-libs/",
      ]);
    });

    it("decodes real settings.json permissions block", () => {
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
      assert.ok(result.permissions !== undefined);
      assert.strictEqual(result.permissions.allow?.length, 4);
      assert.strictEqual(result.permissions.deny?.length, 3);
      assert.strictEqual(result.permissions.ask?.length, 2);
      assert.strictEqual(result.defaultMode, "dontAsk");
    });
  });

  describe("encode (canonical → Claude Code)", () => {
    it("produces valid Claude Code permissions block", () => {
      const encoded = z.encode(claudeCodeCodec, {
        permissions: {
          allow: ["Bash(git status)", "Read"],
          deny: ["Bash(sudo:*)"],
          ask: ["Bash(git push:*)"],
        },
        defaultMode: "dontAsk",
      });
      assert.deepStrictEqual(encoded.allow, ["Bash(git status)", "Read"]);
      assert.deepStrictEqual(encoded.deny, ["Bash(sudo:*)"]);
      assert.deepStrictEqual(encoded.ask, ["Bash(git push:*)"]);
      assert.strictEqual(encoded.defaultMode, "dontAsk");
    });

    it("places defaultMode in permissions block (Claude Code placement)", () => {
      const encoded = z.encode(claudeCodeCodec, {
        permissions: { allow: ["Read"], defaultMode: "plan" },
      });
      assert.strictEqual(encoded.defaultMode, "plan");
    });
  });

  describe("round-trip (native → canonical → native)", () => {
    it("preserves allow/deny/ask/defaultMode through full cycle", () => {
      const native = {
        allow: ["Bash(git status)", "Read", "Bash(npm run test:*)"],
        deny: ["Bash(sudo:*)", "Bash(rm -rf /)"],
        ask: ["Bash(git push:*)"],
        defaultMode: "dontAsk" as const,
      };
      const canonical = claudeCodeCodec.decode(native);
      const reEncoded = z.encode(claudeCodeCodec, canonical);
      const reDecoded = claudeCodeCodec.decode(reEncoded);
      assert.ok(reDecoded.permissions !== undefined);
      assert.deepStrictEqual(reDecoded.permissions.allow, native.allow);
      assert.deepStrictEqual(reDecoded.permissions.deny, native.deny);
      assert.deepStrictEqual(reDecoded.permissions.ask, native.ask);
      assert.strictEqual(reDecoded.defaultMode, "dontAsk");
    });

    it("preserves additionalDirectories through full cycle", () => {
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

    it("preserves real settings.json through full cycle", () => {
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
      assert.ok(reDecoded.permissions !== undefined);
      assert.deepStrictEqual(reDecoded.permissions.allow, native.allow);
      assert.deepStrictEqual(reDecoded.permissions.deny, native.deny);
      assert.deepStrictEqual(reDecoded.permissions.ask, native.ask);
      assert.strictEqual(reDecoded.defaultMode, "dontAsk");
    });
  });
});

// ---------------------------------------------------------------------------
// OpenCode codec
// ---------------------------------------------------------------------------

describe("opencodeCodec", () => {
  describe("decode (OpenCode → canonical)", () => {
    it("converts 'allow' shorthand to autonomous mode", () => {
      assert.strictEqual(
        opencodeCodec.decode("allow").defaultMode,
        "autonomous",
      );
    });

    it("converts 'deny' shorthand to restricted mode", () => {
      assert.strictEqual(
        opencodeCodec.decode("deny").defaultMode,
        "restricted",
      );
    });

    it("converts granular bash rules to canonical patterns", () => {
      const result = opencodeCodec.decode({
        bash: { "*": "ask", "git *": "allow", "rm *": "deny" },
      });
      assert.ok(result.permissions?.ask?.includes("Bash(*)"));
      assert.ok(result.permissions?.allow?.includes("Bash(git *)"));
      assert.ok(result.permissions?.deny?.includes("Bash(rm *)"));
    });

    it("converts shorthand tool actions to canonical bare names", () => {
      const result = opencodeCodec.decode({
        edit: "deny",
        read: "allow",
        bash: "ask",
      });
      assert.ok(result.permissions?.deny?.includes("Edit"));
      assert.ok(result.permissions?.allow?.includes("Read"));
      assert.ok(result.permissions?.ask?.includes("Bash"));
    });

    it("maps external_directory to sandbox.writableRoots", () => {
      const result = opencodeCodec.decode({
        external_directory: { "~/projects/lib": "allow" },
      });
      assert.ok(result.sandbox !== undefined);
      assert.deepStrictEqual(result.sandbox.writableRoots, ["~/projects/lib"]);
    });

    it("converts Markdown-defined agent permissions", () => {
      const result = opencodeCodec.decode({
        edit: "deny",
        bash: { "git diff": "allow", "git log*": "allow", "*": "ask" },
        webfetch: "deny",
      });
      assert.ok(result.permissions?.deny?.includes("Edit"));
      assert.ok(result.permissions?.allow?.includes("Bash(git diff)"));
      assert.ok(result.permissions?.ask?.includes("Bash(*)"));
    });
  });

  describe("encode (canonical → OpenCode)", () => {
    it("converts canonical rules to OpenCode granular format", () => {
      const encoded = z.encode(opencodeCodec, {
        permissions: {
          allow: ["Bash(git status *)", "Read"],
          deny: ["Bash(rm *)", "Edit"],
          ask: ["Bash(git push *)"],
        },
      });
      assert.strictEqual(typeof encoded, "object");
      assert.ok(!Array.isArray(encoded));
      assert.strictEqual(typeof encoded, "object");
      assert.ok(!Array.isArray(encoded));
      assert.ok("bash" in (encoded as Record<string, unknown>));
      assert.strictEqual(
        typeof (encoded as Record<string, unknown>).bash,
        "object",
      );
    });

    it("simplifies bare tool names to shorthand", () => {
      const encoded = z.encode(opencodeCodec, {
        permissions: { deny: ["Edit"], allow: ["Read"] },
      });
      assert.strictEqual((encoded as Record<string, unknown>).edit, "deny");
      assert.strictEqual((encoded as Record<string, unknown>).read, "allow");
    });
  });

  describe("round-trip (native → canonical → native)", () => {
    it("preserves granular bash rules through full cycle", () => {
      const native = {
        bash: { "*": "ask", "git *": "allow", "rm *": "deny" },
        read: "allow",
        edit: "deny",
      } as const;
      const canonical = opencodeCodec.decode(native);
      const reEncoded = z.encode(opencodeCodec, canonical);
      const reDecoded = opencodeCodec.decode(reEncoded);
      assert.ok(reDecoded.permissions?.ask?.includes("Bash(*)"));
      assert.ok(reDecoded.permissions?.allow?.includes("Bash(git *)"));
      assert.ok(reDecoded.permissions?.deny?.includes("Bash(rm *)"));
      assert.ok(reDecoded.permissions?.allow?.includes("Read"));
      assert.ok(reDecoded.permissions?.deny?.includes("Edit"));
    });

    it("preserves shorthand action through full cycle", () => {
      const canonical = opencodeCodec.decode("allow");
      assert.strictEqual(canonical.defaultMode, "autonomous");
      const encoded = z.encode(opencodeCodec, canonical);
      assert.ok(typeof encoded === "object");
    });

    it("preserves mixed shorthand + granular rules", () => {
      const native = {
        bash: { "git diff": "allow", "git log*": "allow", "*": "ask" },
        edit: "deny",
        webfetch: "deny",
      } as const;
      const canonical = opencodeCodec.decode(native);
      const reEncoded = z.encode(opencodeCodec, canonical);
      const reDecoded = opencodeCodec.decode(reEncoded);
      assert.ok(reDecoded.permissions?.allow?.includes("Bash(git diff)"));
      assert.ok(reDecoded.permissions?.allow?.includes("Bash(git log*)"));
      assert.ok(reDecoded.permissions?.ask?.includes("Bash(*)"));
      assert.ok(reDecoded.permissions?.deny?.includes("Edit"));
      assert.ok(reDecoded.permissions?.deny?.includes("WebFetch"));
    });

    it("preserves external_directory through full cycle via sandbox", () => {
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

describe("crushCodec", () => {
  describe("decode (Crush → canonical)", () => {
    it("maps lowercase tool names to canonical PascalCase", () => {
      const result = crushCodec.decode({
        allowed_tools: ["view", "ls", "grep", "edit", "bash"],
      });
      assert.ok(result.permissions !== undefined);
      assert.deepStrictEqual(result.permissions.allow, [
        "Read",
        "Glob",
        "Grep",
        "Edit",
        "Bash",
      ]);
    });

    it("passes through unknown tool names as-is", () => {
      const result = crushCodec.decode({
        allowed_tools: ["mcp_context7_get-library-doc"],
      });
      assert.ok(result.permissions !== undefined);
      assert.deepStrictEqual(result.permissions.allow, [
        "mcp_context7_get-library-doc",
      ]);
    });
  });

  describe("encode (canonical → Crush)", () => {
    it("maps canonical names to Crush lowercase", () => {
      const encoded = z.encode(crushCodec, {
        permissions: { allow: ["Read", "Grep", "Bash"] },
      });
      assert.deepStrictEqual(encoded.allowed_tools, ["view", "grep", "bash"]);
    });

    it("skips rules with patterns (Crush has no pattern syntax)", () => {
      const encoded = z.encode(crushCodec, {
        permissions: { allow: ["Bash(git status)", "Read"] },
      });
      assert.deepStrictEqual(encoded.allowed_tools, ["view"]);
    });

    it("produces empty allowed_tools for deny-only policy", () => {
      const encoded = z.encode(crushCodec, {
        permissions: { deny: ["Bash(sudo:*)"] },
      });
      assert.deepStrictEqual(encoded.allowed_tools, []);
    });
  });

  describe("round-trip (native → canonical → native)", () => {
    it("preserves bare tool names through full cycle", () => {
      const native = { allowed_tools: ["view", "ls", "grep", "edit", "bash"] };
      const canonical = crushCodec.decode(native);
      assert.deepStrictEqual(
        z.encode(crushCodec, canonical).allowed_tools,
        native.allowed_tools,
      );
    });

    it("preserves MCP tools through full cycle", () => {
      const native = {
        allowed_tools: ["view", "bash", "mcp_context7_get-library-doc"],
      };
      const canonical = crushCodec.decode(native);
      const reEncoded = z.encode(crushCodec, canonical);
      assert.ok(reEncoded.allowed_tools.includes("view"));
      assert.ok(reEncoded.allowed_tools.includes("bash"));
    });

    it("round-trip is lossy for pattern rules", () => {
      const encoded = z.encode(crushCodec, {
        permissions: { allow: ["Bash(git status)", "Read"] },
      });
      assert.deepStrictEqual(encoded.allowed_tools, ["view"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Codex codec
// ---------------------------------------------------------------------------

describe("codexCodec", () => {
  describe("decode (Codex → canonical)", () => {
    it("maps approval_policy 'untrusted' to restricted mode", () => {
      assert.strictEqual(
        codexCodec.decode({ approval_policy: "untrusted" }).defaultMode,
        "restricted",
      );
    });

    it("maps approval_policy 'never' to autonomous mode", () => {
      assert.strictEqual(
        codexCodec.decode({ approval_policy: "never" }).defaultMode,
        "autonomous",
      );
    });

    it("maps approval_policy 'on-request' to standard mode", () => {
      assert.strictEqual(
        codexCodec.decode({ approval_policy: "on-request" }).defaultMode,
        "standard",
      );
    });

    it("maps sandbox_mode 'read-only' to readonly mode", () => {
      const result = codexCodec.decode({ sandbox_mode: "read-only" });
      assert.strictEqual(result.defaultMode, "readonly");
      assert.ok(result.permissions?.deny?.includes("Write"));
      assert.ok(result.permissions?.deny?.includes("Edit"));
    });

    it("maps sandbox_mode 'danger-full-access' to autonomous", () => {
      assert.strictEqual(
        codexCodec.decode({ sandbox_mode: "danger-full-access" }).defaultMode,
        "autonomous",
      );
    });

    it("maps sandbox_workspace_write.writable_roots to sandbox.writableRoots", () => {
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

    it("converts filesystem shorthand 'read' to Write+Edit deny", () => {
      const result = codexCodec.decode({
        permissions: { strict: { filesystem: "read" } },
        default_permissions: "strict",
      });
      assert.ok(result.permissions?.deny?.includes("Write"));
      assert.ok(result.permissions?.deny?.includes("Edit"));
    });

    it("converts filesystem shorthand 'none' to full deny", () => {
      const result = codexCodec.decode({
        permissions: { locked: { filesystem: "none" } },
        default_permissions: "locked",
      });
      assert.ok(result.permissions?.deny?.includes("Read"));
      assert.ok(result.permissions?.deny?.includes("Write"));
      assert.ok(result.permissions?.deny?.includes("Edit"));
    });

    it("converts granular filesystem rules to path-based deny rules", () => {
      const result = codexCodec.decode({
        permissions: {
          default: {
            filesystem: { "/etc/config": "read", "/secrets": "none" },
          },
        },
        default_permissions: "default",
      });
      assert.ok(result.permissions?.deny?.includes("Write(./etc/config)"));
      assert.ok(result.permissions?.deny?.includes("Edit(./etc/config)"));
      assert.ok(result.permissions?.deny?.includes("Read(./secrets)"));
      assert.ok(result.permissions?.deny?.includes("Write(./secrets)"));
    });

    it("converts network domain rules to WebFetch rules", () => {
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
      assert.ok(
        result.permissions?.allow?.includes("WebFetch(domain:api.example.com)"),
      );
      assert.ok(
        result.permissions?.deny?.includes("WebFetch(domain:evil.com)"),
      );
    });

    it("uses all profiles when default_permissions is unset", () => {
      const result = codexCodec.decode({
        permissions: {
          safe: { filesystem: "read" },
          open: { filesystem: "write" },
        },
      });
      assert.ok(result.permissions?.deny?.includes("Write"));
      assert.ok(result.permissions?.deny?.includes("Edit"));
    });
  });

  describe("encode (canonical → Codex)", () => {
    it("maps defaultMode to approval_policy + sandbox_mode", () => {
      const encoded = z.encode(codexCodec, { defaultMode: "standard" });
      assert.strictEqual(encoded.approval_policy, "on-request");
      assert.strictEqual(encoded.sandbox_mode, "workspace-write");
    });

    it("maps autonomous to never + danger-full-access", () => {
      const encoded = z.encode(codexCodec, { defaultMode: "autonomous" });
      assert.strictEqual(encoded.approval_policy, "never");
      assert.strictEqual(encoded.sandbox_mode, "danger-full-access");
    });

    it("maps readonly to untrusted + read-only", () => {
      const encoded = z.encode(codexCodec, { defaultMode: "restricted" });
      assert.strictEqual(encoded.approval_policy, "untrusted");
      assert.strictEqual(encoded.sandbox_mode, "workspace-write");
    });

    it("maps sandbox.writableRoots to writable_roots", () => {
      const encoded = z.encode(codexCodec, {
        sandbox: { writableRoots: ["/tmp/build-cache"] },
      });
      assert.ok(encoded.sandbox_workspace_write !== undefined);
      assert.deepStrictEqual(encoded.sandbox_workspace_write.writable_roots, [
        "/tmp/build-cache",
      ]);
    });

    it("converts deny rules to filesystem + network profile", () => {
      const encoded = z.encode(codexCodec, {
        permissions: {
          deny: [
            "Write(./secrets)",
            "Read(./secrets)",
            "WebFetch(domain:evil.com)",
          ],
          allow: ["WebFetch(domain:api.example.com)"],
        },
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

  describe("round-trip (native → canonical → native)", () => {
    it("preserves approval_policy + sandbox_mode through full cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        sandbox_mode: "workspace-write" as const,
      };
      const reEncoded = z.encode(codexCodec, codexCodec.decode(native));
      assert.strictEqual(reEncoded.approval_policy, "on-request");
      assert.strictEqual(reEncoded.sandbox_mode, "workspace-write");
    });

    it("preserves autonomous mode through full cycle", () => {
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

    it("preserves writable_roots through full cycle", () => {
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

    it("preserves filesystem granular rules through full cycle", () => {
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
      assert.ok(canonical.permissions?.deny?.includes("Read(./secrets)"));
      assert.ok(canonical.permissions?.deny?.includes("Write(./secrets)"));
      assert.ok(canonical.permissions?.deny?.includes("Write(./etc/config)"));
      const reEncoded = z.encode(codexCodec, canonical);
      const profile = getCodexProfile(reEncoded, "default");
      const fs = getFilesystemRecord(profile.filesystem);
      assert.strictEqual(fs["/secrets"], "none");
      assert.strictEqual(fs["/etc/config"], "read");
    });

    it("preserves network domain rules through full cycle", () => {
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
      assert.ok(
        canonical.permissions?.allow?.includes(
          "WebFetch(domain:api.example.com)",
        ),
      );
      assert.ok(
        canonical.permissions?.deny?.includes("WebFetch(domain:evil.com)"),
      );
      const reEncoded = z.encode(codexCodec, canonical);
      const profile = getCodexProfile(reEncoded, "default");
      const domains = getNetworkDomains(profile.network);
      assert.strictEqual(domains["api.example.com"], "allow");
      assert.strictEqual(domains["evil.com"], "deny");
    });

    it("round-trip is lossy for Bash rules", () => {
      const encoded = z.encode(codexCodec, {
        defaultMode: "standard" as const,
        permissions: {
          allow: ["Bash(git status)", "Read"],
          deny: ["Bash(sudo:*)"],
        },
      });
      assert.strictEqual(encoded.approval_policy, "on-request");
      assert.strictEqual(encoded.sandbox_mode, "workspace-write");
    });

    it("round-trip is lossy for sandbox_mode read-only", () => {
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

  describe("sandbox round-trip", () => {
    it("preserves full sandbox config through cycle", () => {
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

    it("preserves danger-full-access sandbox through cycle", () => {
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

  describe("named profiles round-trip", () => {
    it("preserves named profiles through cycle", () => {
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

  describe("network round-trip", () => {
    it("preserves network domains through cycle", () => {
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
