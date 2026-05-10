import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  claudeCodeCodec,
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

  describe("round-trip", () => {
    it("preserves canonical data through encode→decode", () => {
      const canonical = {
        permissions: {
          allow: ["Bash(git status)", "Read"],
          deny: ["Bash(sudo:*)"],
        },
        defaultMode: "dontAsk" as const,
      };
      const encoded = z.encode(claudeCodeCodec, canonical);
      const decoded = claudeCodeCodec.decode(encoded);
      expect(decoded.permissions?.allow).toEqual(["Bash(git status)", "Read"]);
      expect(decoded.permissions?.deny).toEqual(["Bash(sudo:*)"]);
      expect(decoded.defaultMode).toBe("dontAsk");
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

  describe("round-trip", () => {
    it("preserves bare tool names through decode→encode", () => {
      const canonical = crushCodec.decode({
        allowed_tools: ["view", "ls", "grep", "edit", "bash"],
      });
      const reEncoded = z.encode(crushCodec, canonical);
      expect(reEncoded.allowed_tools).toEqual(["view", "ls", "grep", "edit", "bash"]);
    });
  });
});
