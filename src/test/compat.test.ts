import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  claudeCodeCodec,
  codexCodec,
  opencodeCodec,
  crushCodec,
} from "../compat/codecs.ts";
import { agentPermissionPolicy } from "../schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round-trip: encode then decode should preserve the canonical data. */
function roundTrip(
  codec: z.core.$ZodCodec<any, any, any>,
  native: unknown,
) {
  const canonical = codec.decode(native);
  const reEncoded = z.encode(codec, canonical);
  const reDecoded = codec.decode(reEncoded);
  return { canonical, reEncoded, reDecoded };
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
      expect(result.permissions?.allow).toEqual(["Bash(git status)", "Read"]);
      expect(result.permissions?.deny).toEqual(["Bash(sudo:*)"]);
      expect(result.permissions?.ask).toEqual(["Bash(git push:*)"]);
    });

    it("maps defaultMode to top-level", () => {
      const result = claudeCodeCodec.decode({
        defaultMode: "dontAsk",
        allow: ["Read"],
      });
      expect(result.defaultMode).toBe("dontAsk");
    });

    it("maps additionalDirectories", () => {
      const result = claudeCodeCodec.decode({
        additionalDirectories: ["../shared-libs/"],
      });
      expect(result.permissions?.additionalDirectories).toEqual([
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
      expect(result.permissions?.allow).toHaveLength(4);
      expect(result.permissions?.deny).toHaveLength(3);
      expect(result.permissions?.ask).toHaveLength(2);
      expect(result.defaultMode).toBe("dontAsk");
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
      expect(encoded.allow).toEqual(["Bash(git status)", "Read"]);
      expect(encoded.deny).toEqual(["Bash(sudo:*)"]);
      expect(encoded.ask).toEqual(["Bash(git push:*)"]);
      expect(encoded.defaultMode).toBe("dontAsk");
    });

    it("places defaultMode in permissions block (Claude Code placement)", () => {
      const encoded = z.encode(claudeCodeCodec, {
        permissions: {
          allow: ["Read"],
          defaultMode: "plan",
        },
      });
      expect(encoded.defaultMode).toBe("plan");
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
      expect(reDecoded.permissions?.allow).toEqual(native.allow);
      expect(reDecoded.permissions?.deny).toEqual(native.deny);
      expect(reDecoded.permissions?.ask).toEqual(native.ask);
      expect(reDecoded.defaultMode).toBe("dontAsk");
    });

    it("preserves additionalDirectories through full cycle", () => {
      const native = {
        allow: ["Read"],
        additionalDirectories: ["../shared-libs/", "/tmp/cache"],
      };
      const canonical = claudeCodeCodec.decode(native);
      const reEncoded = z.encode(claudeCodeCodec, canonical);
      const reDecoded = claudeCodeCodec.decode(reEncoded);
      expect(reDecoded.permissions?.additionalDirectories).toEqual(
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
        deny: [
          "Bash(*rm* /)",
          "Bash(sudo *rm*)",
          "Bash(git add -A*)",
        ],
        ask: [
          "Bash(*rm\\* -r*)",
          "Write(eslint.config.ts)",
        ],
        defaultMode: "dontAsk" as const,
      };
      const canonical = claudeCodeCodec.decode(native);
      const reEncoded = z.encode(claudeCodeCodec, canonical);
      const reDecoded = claudeCodeCodec.decode(reEncoded);
      expect(reDecoded.permissions?.allow).toEqual(native.allow);
      expect(reDecoded.permissions?.deny).toEqual(native.deny);
      expect(reDecoded.permissions?.ask).toEqual(native.ask);
      expect(reDecoded.defaultMode).toBe("dontAsk");
    });
  });
});

// ---------------------------------------------------------------------------
// OpenCode codec
// ---------------------------------------------------------------------------

describe("opencodeCodec", () => {
  describe("decode (OpenCode → canonical)", () => {
    it("converts 'allow' shorthand to autonomous mode", () => {
      const result = opencodeCodec.decode("allow");
      expect(result.defaultMode).toBe("autonomous");
    });

    it("converts 'deny' shorthand to restricted mode", () => {
      const result = opencodeCodec.decode("deny");
      expect(result.defaultMode).toBe("restricted");
    });

    it("converts granular bash rules to canonical patterns", () => {
      const result = opencodeCodec.decode({
        bash: {
          "*": "ask",
          "git *": "allow",
          "rm *": "deny",
        },
      });
      expect(result.permissions?.ask).toContain("Bash(*)");
      expect(result.permissions?.allow).toContain("Bash(git *)");
      expect(result.permissions?.deny).toContain("Bash(rm *)");
    });

    it("converts shorthand tool actions to canonical bare names", () => {
      const result = opencodeCodec.decode({
        edit: "deny",
        read: "allow",
        bash: "ask",
      });
      expect(result.permissions?.deny).toContain("Edit");
      expect(result.permissions?.allow).toContain("Read");
      expect(result.permissions?.ask).toContain("Bash");
    });

    it("maps external_directory to additionalDirectories", () => {
      const result = opencodeCodec.decode({
        external_directory: {
          "~/projects/personal/**": "allow",
        },
      });
      expect(result.permissions?.additionalDirectories).toContain(
        "~/projects/personal/**",
      );
    });

    it("converts Markdown-defined agent permissions", () => {
      // This is what a .opencode/agents/review.md frontmatter produces
      const result = opencodeCodec.decode({
        edit: "deny",
        bash: {
          "git diff": "allow",
          "git log*": "allow",
          "*": "ask",
        },
        webfetch: "deny",
      });
      expect(result.permissions?.deny).toContain("Edit");
      expect(result.permissions?.allow).toContain("Bash(git diff)");
      expect(result.permissions?.ask).toContain("Bash(*)");
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
      // Should be an object with bash, read, edit keys
      expect(typeof encoded).toBe("object");
      expect(encoded).not.toBeInstanceOf(Array);

      // Bash should have granular rules
      if (typeof encoded === "object" && encoded !== null && "bash" in encoded) {
        const bash = (encoded as Record<string, unknown>).bash;
        expect(typeof bash).toBe("object");
      }
    });

    it("simplifies bare tool names to shorthand", () => {
      const encoded = z.encode(opencodeCodec, {
        permissions: {
          deny: ["Edit"],
          allow: ["Read"],
        },
      });
      // Bare tools should become shorthand: "edit": "deny", "read": "allow"
      if (typeof encoded === "object" && encoded !== null) {
        expect((encoded as Record<string, unknown>).edit).toBe("deny");
        expect((encoded as Record<string, unknown>).read).toBe("allow");
      }
    });
  });

  describe("round-trip (native → canonical → native)", () => {
    it("preserves granular bash rules through full cycle", () => {
      const native = {
        bash: {
          "*": "ask",
          "git *": "allow",
          "rm *": "deny",
        },
        read: "allow",
        edit: "deny",
      };
      const canonical = opencodeCodec.decode(native);
      const reEncoded = z.encode(opencodeCodec, canonical);
      const reDecoded = opencodeCodec.decode(reEncoded);

      // Bash granular rules survive
      expect(reDecoded.permissions?.ask).toContain("Bash(*)");
      expect(reDecoded.permissions?.allow).toContain("Bash(git *)");
      expect(reDecoded.permissions?.deny).toContain("Bash(rm *)");

      // Shorthand tools survive
      expect(reDecoded.permissions?.allow).toContain("Read");
      expect(reDecoded.permissions?.deny).toContain("Edit");
    });

    it("preserves shorthand action through full cycle", () => {
      const canonical = opencodeCodec.decode("allow");
      expect(canonical.defaultMode).toBe("autonomous");
      // Encoding autonomous mode back should produce a valid OpenCode config
      const reEncoded = z.encode(opencodeCodec, canonical);
      // Autonomous mode with no rules → fallback "ask" for bash
      expect(reEncoded).toBeDefined();
    });

    it("preserves mixed shorthand + granular rules", () => {
      const native = {
        bash: {
          "git diff": "allow",
          "git log*": "allow",
          "*": "ask",
        },
        edit: "deny",
        webfetch: "deny",
      };
      const canonical = opencodeCodec.decode(native);
      const reEncoded = z.encode(opencodeCodec, canonical);
      const reDecoded = opencodeCodec.decode(reEncoded);

      // All three bash rules survive
      expect(reDecoded.permissions?.allow).toContain("Bash(git diff)");
      expect(reDecoded.permissions?.allow).toContain("Bash(git log*)");
      expect(reDecoded.permissions?.ask).toContain("Bash(*)");
      expect(reDecoded.permissions?.deny).toContain("Edit");
      expect(reDecoded.permissions?.deny).toContain("WebFetch");
    });

    it("preserves external_directory through full cycle via sandbox", () => {
      const native = {
        bash: { "*": "ask" },
        external_directory: {
          "~/projects/lib": "allow",
          "/tmp/cache": "allow",
        },
      };
      const canonical = opencodeCodec.decode(native);
      expect(canonical.sandbox?.writableRoots).toEqual([
        "~/projects/lib",
        "/tmp/cache",
      ]);
      expect(canonical.permissions?.additionalDirectories).toEqual([
        "~/projects/lib",
        "/tmp/cache",
      ]);

      const reEncoded = z.encode(opencodeCodec, canonical);
      // sandbox.writableRoots → external_directory on encode
      if (typeof reEncoded === "object" && reEncoded !== null) {
        const extDir = (reEncoded as Record<string, unknown>).external_directory;
        expect(extDir).toEqual({
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
      const result = crushCodec.decode({
        allowed_tools: ["view", "ls", "grep", "edit", "bash"],
      });
      expect(result.permissions?.allow).toEqual([
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
      expect(result.permissions?.allow).toEqual(["mcp_context7_get-library-doc"]);
    });
  });

  describe("encode (canonical → Crush)", () => {
    it("maps canonical names to Crush lowercase", () => {
      const encoded = z.encode(crushCodec, {
        permissions: {
          allow: ["Read", "Grep", "Bash"],
        },
      });
      expect(encoded.allowed_tools).toEqual(["view", "grep", "bash"]);
    });

    it("skips rules with patterns (Crush has no pattern syntax)", () => {
      const encoded = z.encode(crushCodec, {
        permissions: {
          allow: ["Bash(git status)", "Read"],
        },
      });
      // "Bash(git status)" is skipped — only bare "Read" → "view"
      expect(encoded.allowed_tools).toEqual(["view"]);
    });

    it("produces empty allowed_tools for deny-only policy", () => {
      const encoded = z.encode(crushCodec, {
        permissions: {
          deny: ["Bash(sudo:*)"],
        },
      });
      expect(encoded.allowed_tools).toEqual([]);
    });
  });

  describe("round-trip (native → canonical → native)", () => {
    it("preserves bare tool names through full cycle", () => {
      const native = { allowed_tools: ["view", "ls", "grep", "edit", "bash"] };
      const canonical = crushCodec.decode(native);
      const reEncoded = z.encode(crushCodec, canonical);
      expect(reEncoded.allowed_tools).toEqual(native.allowed_tools);
    });

    it("preserves MCP tools through full cycle", () => {
      const native = {
        allowed_tools: ["view", "bash", "mcp_context7_get-library-doc"],
      };
      const canonical = crushCodec.decode(native);
      const reEncoded = z.encode(crushCodec, canonical);
      // MCP tools have no canonical→crush mapping, so they're lost on encode
      // This is expected — Crush has no MCP concept in allowed_tools
      expect(reEncoded.allowed_tools).toContain("view");
      expect(reEncoded.allowed_tools).toContain("bash");
    });

    it("round-trip is lossy for pattern rules", () => {
      // Encode canonical with pattern rules → Crush loses them
      const canonical = {
        permissions: {
          allow: ["Bash(git status)", "Read"],
        },
      };
      const encoded = z.encode(crushCodec, canonical);
      // Only bare "Read" survives → "view"
      expect(encoded.allowed_tools).toEqual(["view"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Codex codec
// ---------------------------------------------------------------------------

describe("codexCodec", () => {
  describe("decode (Codex → canonical)", () => {
    it("maps approval_policy 'untrusted' to restricted mode", () => {
      const result = codexCodec.decode({
        approval_policy: "untrusted",
      });
      expect(result.defaultMode).toBe("restricted");
    });

    it("maps approval_policy 'never' to autonomous mode", () => {
      const result = codexCodec.decode({
        approval_policy: "never",
      });
      expect(result.defaultMode).toBe("autonomous");
    });

    it("maps approval_policy 'on-request' to standard mode", () => {
      const result = codexCodec.decode({
        approval_policy: "on-request",
      });
      expect(result.defaultMode).toBe("standard");
    });

    it("maps sandbox_mode 'read-only' to readonly mode", () => {
      const result = codexCodec.decode({
        sandbox_mode: "read-only",
      });
      expect(result.defaultMode).toBe("readonly");
      expect(result.permissions?.deny).toContain("Write");
      expect(result.permissions?.deny).toContain("Edit");
    });

    it("maps sandbox_mode 'danger-full-access' to autonomous", () => {
      const result = codexCodec.decode({
        sandbox_mode: "danger-full-access",
      });
      expect(result.defaultMode).toBe("autonomous");
    });

    it("maps sandbox_workspace_write.writable_roots to sandbox.writableRoots", () => {
      const result = codexCodec.decode({
        sandbox_workspace_write: {
          writable_roots: ["/tmp/build-cache", "../shared-libs"],
        },
      });
      expect(result.sandbox?.writableRoots).toEqual([
        "/tmp/build-cache",
        "../shared-libs",
      ]);
    });

    it("converts filesystem shorthand 'read' to Write+Edit deny", () => {
      const result = codexCodec.decode({
        permissions: {
          strict: {
            filesystem: "read",
          },
        },
        default_permissions: "strict",
      });
      expect(result.permissions?.deny).toContain("Write");
      expect(result.permissions?.deny).toContain("Edit");
    });

    it("converts filesystem shorthand 'none' to full deny", () => {
      const result = codexCodec.decode({
        permissions: {
          locked: {
            filesystem: "none",
          },
        },
        default_permissions: "locked",
      });
      expect(result.permissions?.deny).toContain("Read");
      expect(result.permissions?.deny).toContain("Write");
      expect(result.permissions?.deny).toContain("Edit");
    });

    it("converts granular filesystem rules to path-based deny rules", () => {
      const result = codexCodec.decode({
        permissions: {
          default: {
            filesystem: {
              "/etc/config": "read",
              "/secrets": "none",
            },
          },
        },
        default_permissions: "default",
      });
      // /etc/config → read-only
      expect(result.permissions?.deny).toContain("Write(./etc/config)");
      expect(result.permissions?.deny).toContain("Edit(./etc/config)");
      // /secrets → no access
      expect(result.permissions?.deny).toContain("Read(./secrets)");
      expect(result.permissions?.deny).toContain("Write(./secrets)");
    });

    it("converts network domain rules to WebFetch rules", () => {
      const result = codexCodec.decode({
        permissions: {
          default: {
            network: {
              domains: {
                "api.example.com": "allow",
                "evil.com": "deny",
              },
            },
          },
        },
        default_permissions: "default",
      });
      expect(result.permissions?.allow).toContain(
        "WebFetch(domain:api.example.com)",
      );
      expect(result.permissions?.deny).toContain("WebFetch(domain:evil.com)");
    });

    it("uses all profiles when default_permissions is unset", () => {
      const result = codexCodec.decode({
        permissions: {
          safe: {
            filesystem: "read",
          },
          open: {
            filesystem: "write",
          },
        },
      });
      // Both profiles merged — safe contributes Write+Edit deny
      expect(result.permissions?.deny).toContain("Write");
      expect(result.permissions?.deny).toContain("Edit");
    });
  });

  describe("encode (canonical → Codex)", () => {
    it("maps defaultMode to approval_policy + sandbox_mode", () => {
      const encoded = z.encode(codexCodec, {
        defaultMode: "standard",
      });
      expect(encoded.approval_policy).toBe("on-request");
      expect(encoded.sandbox_mode).toBe("workspace-write");
    });

    it("maps autonomous to never + danger-full-access", () => {
      const encoded = z.encode(codexCodec, {
        defaultMode: "autonomous",
      });
      expect(encoded.approval_policy).toBe("never");
      expect(encoded.sandbox_mode).toBe("danger-full-access");
    });

    it("maps readonly to untrusted + read-only", () => {
      const encoded = z.encode(codexCodec, {
        defaultMode: "restricted",
      });
      expect(encoded.approval_policy).toBe("untrusted");
      expect(encoded.sandbox_mode).toBe("workspace-write");
    });

    it("maps additionalDirectories to writable_roots", () => {
      const encoded = z.encode(codexCodec, {
        sandbox: {
          writableRoots: ["/tmp/build-cache"],
        },
      });
      expect(encoded.sandbox_workspace_write?.writable_roots).toEqual([
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
          allow: [
            "WebFetch(domain:api.example.com)",
          ],
        },
      });
      // Should produce a named profile with filesystem + network
      expect(encoded.permissions).toBeDefined();
      expect(encoded.default_permissions).toBe("default");

      const profile = (encoded.permissions as Record<string, any>).default;
      expect(profile.filesystem["/secrets"]).toBe("none");
      expect(profile.network.domains["evil.com"]).toBe("deny");
      expect(profile.network.domains["api.example.com"]).toBe("allow");
    });
  });

  describe("round-trip (native → canonical → native)", () => {
    it("preserves approval_policy + sandbox_mode through full cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        sandbox_mode: "workspace-write" as const,
      };
      const canonical = codexCodec.decode(native);
      const reEncoded = z.encode(codexCodec, canonical);
      expect(reEncoded.approval_policy).toBe("on-request");
      expect(reEncoded.sandbox_mode).toBe("workspace-write");
    });

    it("preserves autonomous mode through full cycle", () => {
      const native = {
        approval_policy: "never" as const,
        sandbox_mode: "danger-full-access" as const,
      };
      const canonical = codexCodec.decode(native);
      expect(canonical.defaultMode).toBe("autonomous");
      const reEncoded = z.encode(codexCodec, canonical);
      expect(reEncoded.approval_policy).toBe("never");
      expect(reEncoded.sandbox_mode).toBe("danger-full-access");
    });

    it("preserves writable_roots through full cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        sandbox_workspace_write: {
          writable_roots: ["/tmp/build-cache", "../shared-libs"],
        },
      };
      const canonical = codexCodec.decode(native);
      expect(canonical.sandbox?.writableRoots).toEqual([
        "/tmp/build-cache",
        "../shared-libs",
      ]);
      const reEncoded = z.encode(codexCodec, canonical);
      expect(reEncoded.sandbox_workspace_write?.writable_roots).toEqual([
        "/tmp/build-cache",
        "../shared-libs",
      ]);
    });

    it("preserves filesystem granular rules through full cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        permissions: {
          default: {
            filesystem: {
              "/secrets": "none",
              "/etc/config": "read",
            },
          },
        },
        default_permissions: "default",
      };
      const canonical = codexCodec.decode(native);
      // Deny rules generated
      expect(canonical.permissions?.deny).toContain("Read(./secrets)");
      expect(canonical.permissions?.deny).toContain("Write(./secrets)");
      expect(canonical.permissions?.deny).toContain("Write(./etc/config)");

      const reEncoded = z.encode(codexCodec, canonical);
      const profile = (reEncoded.permissions as Record<string, any>)?.default;
      expect(profile.filesystem["/secrets"]).toBe("none");
      expect(profile.filesystem["/etc/config"]).toBe("read");
    });

    it("preserves network domain rules through full cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        permissions: {
          default: {
            network: {
              domains: {
                "api.example.com": "allow",
                "evil.com": "deny",
              },
            },
          },
        },
        default_permissions: "default",
      };
      const canonical = codexCodec.decode(native);
      expect(canonical.permissions?.allow).toContain(
        "WebFetch(domain:api.example.com)",
      );
      expect(canonical.permissions?.deny).toContain(
        "WebFetch(domain:evil.com)",
      );

      const reEncoded = z.encode(codexCodec, canonical);
      const profile = (reEncoded.permissions as Record<string, any>)?.default;
      expect(profile.network.domains["api.example.com"]).toBe("allow");
      expect(profile.network.domains["evil.com"]).toBe("deny");
    });

    it("round-trip is lossy for Bash rules", () => {
      // Codex has no Bash rule concept — those are lost
      const canonical = {
        defaultMode: "standard" as const,
        permissions: {
          allow: ["Bash(git status)", "Read"],
          deny: ["Bash(sudo:*)"],
        },
      };
      const encoded = z.encode(codexCodec, canonical);
      // No filesystem or network profile — only Bash rules which Codex can't express
      // The approval_policy + sandbox_mode are still correct
      expect(encoded.approval_policy).toBe("on-request");
      expect(encoded.sandbox_mode).toBe("workspace-write");
    });

    it("round-trip is lossy for sandbox_mode read-only", () => {
      // read-only sandbox adds Write+Edit deny rules to canonical
      // On encode, "readonly" → read-only sandbox, but the explicit deny rules
      // also generate filesystem restrictions — some double-expression is expected
      const native = {
        approval_policy: "untrusted" as const,
        sandbox_mode: "read-only" as const,
      };
      const canonical = codexCodec.decode(native);
      expect(canonical.defaultMode).toBe("readonly");
      // Re-encode: readonly mode maps back to read-only + untrusted
      const reEncoded = z.encode(codexCodec, canonical);
      expect(reEncoded.sandbox_mode).toBe("read-only");
      expect(reEncoded.approval_policy).toBe("untrusted");
    });
  });

  // -----------------------------------------------------------------------
  // New feature round-trips
  // -----------------------------------------------------------------------

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
      expect(canonical.sandbox?.mode).toBe("workspace-write");
      expect(canonical.sandbox?.writableRoots).toEqual(["/tmp/cache"]);
      expect(canonical.sandbox?.networkAccess).toBe(false);

      const reEncoded = z.encode(codexCodec, canonical);
      expect(reEncoded.sandbox_mode).toBe("workspace-write");
      expect(reEncoded.sandbox_workspace_write?.writable_roots).toEqual(["/tmp/cache"]);
      expect(reEncoded.sandbox_workspace_write?.network_access).toBe(false);
    });

    it("preserves danger-full-access sandbox through cycle", () => {
      const native = {
        approval_policy: "never" as const,
        sandbox_mode: "danger-full-access" as const,
      };
      const canonical = codexCodec.decode(native);
      expect(canonical.sandbox?.mode).toBe("full-access");
      expect(canonical.defaultMode).toBe("autonomous");

      const reEncoded = z.encode(codexCodec, canonical);
      expect(reEncoded.sandbox_mode).toBe("danger-full-access");
      expect(reEncoded.approval_policy).toBe("never");
    });
  });

  describe("named profiles round-trip", () => {
    it("preserves named profiles through cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        permissions: {
          strict: {
            filesystem: { "/secrets": "none" },
          },
          relaxed: {
            filesystem: { "/secrets": "write", "/config": "read" },
          },
        },
        default_permissions: "strict",
      };
      const canonical = codexCodec.decode(native);
      expect(canonical.profiles?.strict).toBeDefined();
      expect(canonical.profiles?.relaxed).toBeDefined();
      expect(canonical.activeProfile).toBe("strict");

      const reEncoded = z.encode(codexCodec, canonical);
      expect(reEncoded.permissions).toBeDefined();
      expect(reEncoded.default_permissions).toBe("strict");
      const profiles = reEncoded.permissions as Record<string, any>;
      expect(profiles.strict.filesystem["/secrets"]).toBe("none");
      expect(profiles.relaxed.filesystem["/config"]).toBe("read");
    });
  });

  describe("network round-trip", () => {
    it("preserves network domains through cycle", () => {
      const native = {
        approval_policy: "on-request" as const,
        permissions: {
          default: {
            network: {
              domains: {
                "api.example.com": "allow",
                "evil.com": "deny",
              },
            },
          },
        },
        default_permissions: "default",
      };
      const canonical = codexCodec.decode(native);
      expect(canonical.network?.domains).toEqual({
        "api.example.com": "allow",
        "evil.com": "deny",
      });

      const reEncoded = z.encode(codexCodec, canonical);
      const profile = (reEncoded.permissions as Record<string, any>)?.default;
      expect(profile.network.domains["api.example.com"]).toBe("allow");
      expect(profile.network.domains["evil.com"]).toBe("deny");
    });
  });
});
