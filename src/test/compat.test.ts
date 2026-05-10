import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { z } from "zod";
import {
  claudeCodeCodec,
  codexCodec,
  opencodeCodec,
  crushCodec,
} from "../compat/codecs.ts";

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
      assert.deepStrictEqual(result.permissions?.allow, ["Bash(git status)", "Read"]);
      assert.deepStrictEqual(result.permissions?.deny, ["Bash(sudo:*)"]);
      assert.deepStrictEqual(result.permissions?.ask, ["Bash(git push:*)"]);
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
      assert.deepStrictEqual(result.permissions?.additionalDirectories, ["../shared-libs/"]);
    });

    it("decodes real settings.json permissions block", () => {
      const result = claudeCodeCodec.decode({
        allow: [
          "Bash(du:*)",
          "Bash(python3:*)",
          "Bash(claude plugin:*)",
          "Bash(*rm* -rf */cache/*)",
        ],
        deny: [
          "Bash(*rm* /)",
          "Bash(sudo *rm*)",
          "Bash(git add -A*)",
        ],
        ask: [
          "Bash(*rm\\* -r*)",
          "Write(eslint.config.ts)",
        ],
        defaultMode: "dontAsk",
      });
      assert.strictEqual(result.permissions?.allow?.length, 4);
      assert.strictEqual(result.permissions?.deny?.length, 3);
      assert.strictEqual(result.permissions?.ask?.length, 2);
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
      assert.deepStrictEqual(reDecoded.permissions?.allow, native.allow);
      assert.deepStrictEqual(reDecoded.permissions?.deny, native.deny);
      assert.deepStrictEqual(reDecoded.permissions?.ask, native.ask);
      assert.strictEqual(reDecoded.defaultMode, "dontAsk");
    });

    it("preserves additionalDirectories through full cycle", () => {
      const native = { allow: ["Read"], additionalDirectories: ["../shared-libs/", "/tmp/cache"] };
      const canonical = claudeCodeCodec.decode(native);
      const reEncoded = z.encode(claudeCodeCodec, canonical);
      const reDecoded = claudeCodeCodec.decode(reEncoded);
      assert.deepStrictEqual(reDecoded.permissions?.additionalDirectories, native.additionalDirectories);
    });

    it("preserves real settings.json through full cycle", () => {
      const native = {
        allow: ["Bash(du:*)", "Bash(python3:*)", "Bash(claude plugin:*)", "Bash(*rm* -rf */cache/*)"],
        deny: ["Bash(*rm* /)", "Bash(sudo *rm*)", "Bash(git add -A*)"],
        ask: ["Bash(*rm\\* -r*)", "Write(eslint.config.ts)"],
        defaultMode: "dontAsk" as const,
      };
      const canonical = claudeCodeCodec.decode(native);
      const reEncoded = z.encode(claudeCodeCodec, canonical);
      const reDecoded = claudeCodeCodec.decode(reEncoded);
      assert.deepStrictEqual(reDecoded.permissions?.allow, native.allow);
      assert.deepStrictEqual(reDecoded.permissions?.deny, native.deny);
      assert.deepStrictEqual(reDecoded.permissions?.ask, native.ask);
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
      assert.strictEqual(opencodeCodec.decode("allow").defaultMode, "autonomous");
    });

    it("converts 'deny' shorthand to restricted mode", () => {
      assert.strictEqual(opencodeCodec.decode("deny").defaultMode, "restricted");
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
      const result = opencodeCodec.decode({ edit: "deny", read: "allow", bash: "ask" });
      assert.ok(result.permissions?.deny?.includes("Edit"));
      assert.ok(result.permissions?.allow?.includes("Read"));
      assert.ok(result.permissions?.ask?.includes("Bash"));
    });

    it("maps external_directory to sandbox.writableRoots", () => {
      const result = opencodeCodec.decode({
        external_directory: { "~/projects/lib": "allow" },
      });
      assert.deepStrictEqual(result.sandbox?.writableRoots, ["~/projects/lib"]);
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
        permissions: { allow: ["Bash(git status *)", "Read"], deny: ["Bash(rm *)", "Edit"], ask: ["Bash(git push *)"] },
      });
      assert.strictEqual(typeof encoded, "object");
      assert.ok(!(Array.isArray(encoded)));
      if (typeof encoded === "object" && encoded !== null && "bash" in encoded) {
        assert.strictEqual(typeof (encoded as Record<string, unknown>).bash, "object");
      }
    });

    it("simplifies bare tool names to shorthand", () => {
      const encoded = z.encode(opencodeCodec, {
        permissions: { deny: ["Edit"], allow: ["Read"] },
      });
      if (typeof encoded === "object" && encoded !== null) {
        assert.strictEqual((encoded as Record<string, unknown>).edit, "deny");
        assert.strictEqual((encoded as Record<string, unknown>).read, "allow");
      }
    });
  });

  describe("round-trip (native → canonical → native)", () => {
    it("preserves granular bash rules through full cycle", () => {
      const native = { bash: { "*": "ask", "git *": "allow", "rm *": "deny" }, read: "allow", edit: "deny" };
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
      assert.ok(z.encode(opencodeCodec, canonical) !== undefined);
    });

    it("preserves mixed shorthand + granular rules", () => {
      const native = { bash: { "git diff": "allow", "git log*": "allow", "*": "ask" }, edit: "deny", webfetch: "deny" };
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
      const native = { bash: { "*": "ask" }, external_directory: { "~/projects/lib": "allow", "/tmp/cache": "allow" } };
      const canonical = opencodeCodec.decode(native);
      assert.deepStrictEqual(canonical.sandbox?.writableRoots, ["~/projects/lib", "/tmp/cache"]);
      assert.deepStrictEqual(canonical.permissions?.additionalDirectories, ["~/projects/lib", "/tmp/cache"]);
      const reEncoded = z.encode(opencodeCodec, canonical);
      if (typeof reEncoded === "object" && reEncoded !== null) {
        assert.deepStrictEqual((reEncoded as Record<string, unknown>).external_directory, {
          "~/projects/lib": "allow",
          "/tmp/cache": "allow",
        });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Crush codec
// ---------------------------------------------------------------------------

describe("crushCodec", () => {
  describe("decode (Crush → canonical)", () => {
    it("maps lowercase tool names to canonical PascalCase", () => {
      const result = crushCodec.decode({ allowed_tools: ["view", "ls", "grep", "edit", "bash"] });
      assert.deepStrictEqual(result.permissions?.allow, ["Read", "Glob", "Grep", "Edit", "Bash"]);
    });

    it("passes through unknown tool names as-is", () => {
      const result = crushCodec.decode({ allowed_tools: ["mcp_context7_get-library-doc"] });
      assert.deepStrictEqual(result.permissions?.allow, ["mcp_context7_get-library-doc"]);
    });
  });

  describe("encode (canonical → Crush)", () => {
    it("maps canonical names to Crush lowercase", () => {
      const encoded = z.encode(crushCodec, { permissions: { allow: ["Read", "Grep", "Bash"] } });
      assert.deepStrictEqual(encoded.allowed_tools, ["view", "grep", "bash"]);
    });

    it("skips rules with patterns (Crush has no pattern syntax)", () => {
      const encoded = z.encode(crushCodec, { permissions: { allow: ["Bash(git status)", "Read"] } });
      assert.deepStrictEqual(encoded.allowed_tools, ["view"]);
    });

    it("produces empty allowed_tools for deny-only policy", () => {
      const encoded = z.encode(crushCodec, { permissions: { deny: ["Bash(sudo:*)"] } });
      assert.deepStrictEqual(encoded.allowed_tools, []);
    });
  });

  describe("round-trip (native → canonical → native)", () => {
    it("preserves bare tool names through full cycle", () => {
      const native = { allowed_tools: ["view", "ls", "grep", "edit", "bash"] };
      const canonical = crushCodec.decode(native);
      assert.deepStrictEqual(z.encode(crushCodec, canonical).allowed_tools, native.allowed_tools);
    });

    it("preserves MCP tools through full cycle", () => {
      const native = { allowed_tools: ["view", "bash", "mcp_context7_get-library-doc"] };
      const canonical = crushCodec.decode(native);
      const reEncoded = z.encode(crushCodec, canonical);
      assert.ok(reEncoded.allowed_tools.includes("view"));
      assert.ok(reEncoded.allowed_tools.includes("bash"));
    });

    it("round-trip is lossy for pattern rules", () => {
      const encoded = z.encode(crushCodec, { permissions: { allow: ["Bash(git status)", "Read"] } });
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
      assert.strictEqual(codexCodec.decode({ approval_policy: "untrusted" }).defaultMode, "restricted");
    });

    it("maps approval_policy 'never' to autonomous mode", () => {
      assert.strictEqual(codexCodec.decode({ approval_policy: "never" }).defaultMode, "autonomous");
    });

    it("maps approval_policy 'on-request' to standard mode", () => {
      assert.strictEqual(codexCodec.decode({ approval_policy: "on-request" }).defaultMode, "standard");
    });

    it("maps sandbox_mode 'read-only' to readonly mode", () => {
      const result = codexCodec.decode({ sandbox_mode: "read-only" });
      assert.strictEqual(result.defaultMode, "readonly");
      assert.ok(result.permissions?.deny?.includes("Write"));
      assert.ok(result.permissions?.deny?.includes("Edit"));
    });

    it("maps sandbox_mode 'danger-full-access' to autonomous", () => {
      assert.strictEqual(codexCodec.decode({ sandbox_mode: "danger-full-access" }).defaultMode, "autonomous");
    });

    it("maps sandbox_workspace_write.writable_roots to sandbox.writableRoots", () => {
      const result = codexCodec.decode({
        sandbox_workspace_write: { writable_roots: ["/tmp/build-cache", "../shared-libs"] },
      });
      assert.deepStrictEqual(result.sandbox?.writableRoots, ["/tmp/build-cache", "../shared-libs"]);
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
        permissions: { default: { filesystem: { "/etc/config": "read", "/secrets": "none" } } },
        default_permissions: "default",
      });
      assert.ok(result.permissions?.deny?.includes("Write(./etc/config)"));
      assert.ok(result.permissions?.deny?.includes("Edit(./etc/config)"));
      assert.ok(result.permissions?.deny?.includes("Read(./secrets)"));
      assert.ok(result.permissions?.deny?.includes("Write(./secrets)"));
    });

    it("converts network domain rules to WebFetch rules", () => {
      const result = codexCodec.decode({
        permissions: { default: { network: { domains: { "api.example.com": "allow", "evil.com": "deny" } } } },
        default_permissions: "default",
      });
      assert.ok(result.permissions?.allow?.includes("WebFetch(domain:api.example.com)"));
      assert.ok(result.permissions?.deny?.includes("WebFetch(domain:evil.com)"));
    });

    it("uses all profiles when default_permissions is unset", () => {
      const result = codexCodec.decode({
        permissions: { safe: { filesystem: "read" }, open: { filesystem: "write" } },
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
      const encoded = z.encode(codexCodec, { sandbox: { writableRoots: ["/tmp/build-cache"] } });
      assert.deepStrictEqual(encoded.sandbox_workspace_write?.writable_roots, ["/tmp/build-cache"]);
    });

    it("converts deny rules to filesystem + network profile", () => {
      const encoded = z.encode(codexCodec, {
        permissions: {
          deny: ["Write(./secrets)", "Read(./secrets)", "WebFetch(domain:evil.com)"],
          allow: ["WebFetch(domain:api.example.com)"],
        },
      });
      assert.ok(encoded.permissions !== undefined);
      assert.strictEqual(encoded.default_permissions, "default");
      const profile = (encoded.permissions as Record<string, any>).default;
      assert.strictEqual(profile.filesystem["/secrets"], "none");
      assert.strictEqual(profile.network.domains["evil.com"], "deny");
      assert.strictEqual(profile.network.domains["api.example.com"], "allow");
    });
  });

  describe("round-trip (native → canonical → native)", () => {
    it("preserves approval_policy + sandbox_mode through full cycle", () => {
      const native = { approval_policy: "on-request" as const, sandbox_mode: "workspace-write" as const };
      const reEncoded = z.encode(codexCodec, codexCodec.decode(native));
      assert.strictEqual(reEncoded.approval_policy, "on-request");
      assert.strictEqual(reEncoded.sandbox_mode, "workspace-write");
    });

    it("preserves autonomous mode through full cycle", () => {
      const native = { approval_policy: "never" as const, sandbox_mode: "danger-full-access" as const };
      const canonical = codexCodec.decode(native);
      assert.strictEqual(canonical.defaultMode, "autonomous");
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.approval_policy, "never");
      assert.strictEqual(reEncoded.sandbox_mode, "danger-full-access");
    });

    it("preserves writable_roots through full cycle", () => {
      const native = { approval_policy: "on-request" as const, sandbox_workspace_write: { writable_roots: ["/tmp/build-cache", "../shared-libs"] } };
      const canonical = codexCodec.decode(native);
      assert.deepStrictEqual(canonical.sandbox?.writableRoots, ["/tmp/build-cache", "../shared-libs"]);
      assert.deepStrictEqual(z.encode(codexCodec, canonical).sandbox_workspace_write?.writable_roots, ["/tmp/build-cache", "../shared-libs"]);
    });

    it("preserves filesystem granular rules through full cycle", () => {
      const native = { approval_policy: "on-request" as const, permissions: { default: { filesystem: { "/secrets": "none", "/etc/config": "read" } } }, default_permissions: "default" };
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.permissions?.deny?.includes("Read(./secrets)"));
      assert.ok(canonical.permissions?.deny?.includes("Write(./secrets)"));
      assert.ok(canonical.permissions?.deny?.includes("Write(./etc/config)"));
      const profile = (z.encode(codexCodec, canonical).permissions as Record<string, any>)?.default;
      assert.strictEqual(profile.filesystem["/secrets"], "none");
      assert.strictEqual(profile.filesystem["/etc/config"], "read");
    });

    it("preserves network domain rules through full cycle", () => {
      const native = { approval_policy: "on-request" as const, permissions: { default: { network: { domains: { "api.example.com": "allow", "evil.com": "deny" } } } }, default_permissions: "default" };
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.permissions?.allow?.includes("WebFetch(domain:api.example.com)"));
      assert.ok(canonical.permissions?.deny?.includes("WebFetch(domain:evil.com)"));
      const profile = (z.encode(codexCodec, canonical).permissions as Record<string, any>)?.default;
      assert.strictEqual(profile.network.domains["api.example.com"], "allow");
      assert.strictEqual(profile.network.domains["evil.com"], "deny");
    });

    it("round-trip is lossy for Bash rules", () => {
      const encoded = z.encode(codexCodec, { defaultMode: "standard" as const, permissions: { allow: ["Bash(git status)", "Read"], deny: ["Bash(sudo:*)"] } });
      assert.strictEqual(encoded.approval_policy, "on-request");
      assert.strictEqual(encoded.sandbox_mode, "workspace-write");
    });

    it("round-trip is lossy for sandbox_mode read-only", () => {
      const native = { approval_policy: "untrusted" as const, sandbox_mode: "read-only" as const };
      const canonical = codexCodec.decode(native);
      assert.strictEqual(canonical.defaultMode, "readonly");
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.sandbox_mode, "read-only");
      assert.strictEqual(reEncoded.approval_policy, "untrusted");
    });
  });

  describe("sandbox round-trip", () => {
    it("preserves full sandbox config through cycle", () => {
      const native = { approval_policy: "on-request" as const, sandbox_mode: "workspace-write" as const, sandbox_workspace_write: { writable_roots: ["/tmp/cache"], network_access: false } };
      const canonical = codexCodec.decode(native);
      assert.strictEqual(canonical.sandbox?.mode, "workspace-write");
      assert.deepStrictEqual(canonical.sandbox?.writableRoots, ["/tmp/cache"]);
      assert.strictEqual(canonical.sandbox?.networkAccess, false);
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.sandbox_mode, "workspace-write");
      assert.deepStrictEqual(reEncoded.sandbox_workspace_write?.writable_roots, ["/tmp/cache"]);
      assert.strictEqual(reEncoded.sandbox_workspace_write?.network_access, false);
    });

    it("preserves danger-full-access sandbox through cycle", () => {
      const native = { approval_policy: "never" as const, sandbox_mode: "danger-full-access" as const };
      const canonical = codexCodec.decode(native);
      assert.strictEqual(canonical.sandbox?.mode, "full-access");
      assert.strictEqual(canonical.defaultMode, "autonomous");
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.sandbox_mode, "danger-full-access");
      assert.strictEqual(reEncoded.approval_policy, "never");
    });
  });

  describe("named profiles round-trip", () => {
    it("preserves named profiles through cycle", () => {
      const native = { approval_policy: "on-request" as const, permissions: { strict: { filesystem: { "/secrets": "none" } }, relaxed: { filesystem: { "/secrets": "write", "/config": "read" } } }, default_permissions: "strict" };
      const canonical = codexCodec.decode(native);
      assert.ok(canonical.profiles?.strict !== undefined);
      assert.ok(canonical.profiles?.relaxed !== undefined);
      assert.strictEqual(canonical.activeProfile, "strict");
      const reEncoded = z.encode(codexCodec, canonical);
      assert.strictEqual(reEncoded.default_permissions, "strict");
      const profiles = reEncoded.permissions as Record<string, any>;
      assert.strictEqual(profiles.strict.filesystem["/secrets"], "none");
      assert.strictEqual(profiles.relaxed.filesystem["/config"], "read");
    });
  });

  describe("network round-trip", () => {
    it("preserves network domains through cycle", () => {
      const native = { approval_policy: "on-request" as const, permissions: { default: { network: { domains: { "api.example.com": "allow", "evil.com": "deny" } } } }, default_permissions: "default" };
      const canonical = codexCodec.decode(native);
      assert.deepStrictEqual(canonical.network?.domains, { "api.example.com": "allow", "evil.com": "deny" });
      const profile = (z.encode(codexCodec, canonical).permissions as Record<string, any>)?.default;
      assert.strictEqual(profile.network.domains["api.example.com"], "allow");
      assert.strictEqual(profile.network.domains["evil.com"], "deny");
    });
  });
});
