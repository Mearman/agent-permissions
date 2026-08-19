import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  convert,
  validate,
  check,
  detectFormat,
  detectFormatFromPath,
  resolveFormat,
  ConvertError,
} from "../api.ts";
import type { Format } from "../api.ts";

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------

void describe("detectFormat", () => {
  void it("detects Claude Code from allow/deny/ask string arrays", () => {
    assert.equal(
      detectFormat({ allow: ["Read", "Bash(git status)"] }),
      "claude-code",
    );
    assert.equal(detectFormat({ deny: ["Bash(sudo:*)"] }), "claude-code");
    assert.equal(detectFormat({ ask: ["Write"] }), "claude-code");
  });

  void it("detects Crush from allowed_tools", () => {
    assert.equal(detectFormat({ allowed_tools: ["view", "bash"] }), "crush");
  });

  void it("detects Kiro from allowedTools", () => {
    assert.equal(detectFormat({ allowedTools: ["view"] }), "kiro");
  });

  void it("detects Kiro from toolsSettings", () => {
    assert.equal(detectFormat({ toolsSettings: {} }), "kiro");
  });

  void it("detects Codex from approval_policy", () => {
    assert.equal(detectFormat({ approval_policy: "on-failure" }), "codex");
  });

  void it("detects Codex from sandbox_mode", () => {
    assert.equal(detectFormat({ sandbox_mode: "read-only" }), "codex");
  });

  void it("detects Codex from default_permissions", () => {
    assert.equal(detectFormat({ default_permissions: {} }), "codex");
  });

  void it("detects OpenCode from bare allow string", () => {
    assert.equal(detectFormat("allow"), "opencode");
  });

  void it("detects OpenCode from bare deny string", () => {
    assert.equal(detectFormat("deny"), "opencode");
  });

  void it("detects OpenCode from object with tool keys", () => {
    assert.equal(detectFormat({ bash: "allow", read: "deny" }), "opencode");
  });

  void it("detects exact OMP fragments without claiming unrelated Bash data", () => {
    assert.equal(
      detectFormat({
        bash: {
          patterns: [
            { match: "git status", approval: "allow" },
            { match: "git push", approval: "prompt" },
            { match: "rm *", approval: "deny" },
          ],
        },
      }),
      "omp",
    );
    assert.equal(detectFormat({ bash: { unrelated: "allow" } }), "opencode");
    assert.equal(
      detectFormat({ bash: { patterns: "git status" } }),
      "opencode",
    );
  });

  void it("detects canonical from rules[] with {tool, tier} objects", () => {
    assert.equal(
      detectFormat({ rules: [{ tool: "Bash", tier: "allow" }] }),
      "canonical",
    );
  });

  void it("detects canonical from top-level sandbox", () => {
    assert.equal(detectFormat({ sandbox: {} }), "canonical");
  });

  void it("detects canonical from top-level profiles", () => {
    assert.equal(detectFormat({ profiles: {} }), "canonical");
  });

  void it("detects canonical from top-level delegation", () => {
    assert.equal(detectFormat({ delegation: {} }), "canonical");
  });

  void it("detects canonical from top-level network", () => {
    assert.equal(detectFormat({ network: {} }), "canonical");
  });

  void it("detects canonical from permissions.allow/deny", () => {
    assert.equal(
      detectFormat({ permissions: { allow: ["Read"] } }),
      "canonical",
    );
  });

  void it("detects canonical from defaultMode", () => {
    assert.equal(detectFormat({ defaultMode: "standard" }), "canonical");
  });

  void it("returns undefined for unrecognised input", () => {
    assert.equal(detectFormat({ foo: "bar" }), undefined);
    assert.equal(detectFormat("unknown"), undefined);
    assert.equal(detectFormat(null), undefined);
    assert.equal(detectFormat(42), undefined);
  });
});

void describe("format path recognition", () => {
  void it("recognises OMP's global YAML path", () => {
    assert.equal(
      detectFormatFromPath("/Users/example/.omp/agent/config.yml"),
      "omp",
    );
    assert.equal(resolveFormat("omp"), "omp");
  });
});

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

void describe("convert", () => {
  void it("converts claude-code to canonical with auto-detect", () => {
    const result = convert(undefined, "canonical", {
      allow: ["Read"],
      deny: ["Bash(sudo:*)"],
    });
    assert.equal(result.from, "claude-code");
    assert.equal(result.ruleCount, 2);
    assert.ok(Array.isArray((result.output as Record<string, unknown>).rules));
  });

  void it("converts canonical to crush with explicit from", () => {
    const result = convert("canonical", "crush", {
      rules: [{ tool: "Bash", pattern: "git status", tier: "allow" }],
    });
    assert.equal(result.from, "canonical");
    assert.ok(
      Array.isArray((result.output as Record<string, unknown>).allowed_tools),
    );
  });

  void it("converts canonical to canonical (identity)", () => {
    const policy = {
      rules: [{ tool: "Read", tier: "allow" }],
    };
    const result = convert("canonical", "canonical", policy);
    assert.equal(result.from, "canonical");
    assert.equal(result.ruleCount, 1);
  });

  void it("throws ConvertError on invalid canonical input", () => {
    assert.throws(
      () =>
        convert("canonical", "crush", {
          rules: [{ tool: "Bash", tier: "invalid" }],
        }),
      ConvertError,
    );
  });

  void it("throws TypeError on unknown from format", () => {
    assert.throws(
      () => convert("phantom" as Format, "canonical", {}),
      TypeError,
    );
  });

  void it("throws TypeError on unknown to format", () => {
    assert.throws(
      () => convert("canonical", "phantom" as Format, {}),
      TypeError,
    );
  });

  void it("throws on undetectable format", () => {
    assert.throws(() => convert(undefined, "canonical", { foo: "bar" }), Error);
  });

  void it("includes validation errors in ConvertError", () => {
    try {
      convert("canonical", "crush", {
        rules: [{ tool: "Bash", tier: "maybe" }],
      });
      assert.fail("should have thrown");
    } catch (e) {
      assert.ok(e instanceof ConvertError);
      assert.ok(e.errors.length > 0);
      const first = e.errors[0];
      assert.ok(first !== undefined);
      assert.ok(first.path.length > 0);
      assert.ok(first.message.length > 0);
    }
  });

  void it("converts compatible OpenCode Bash rules through OMP", () => {
    const result = convert("opencode", "omp", {
      bash: {
        "git status": "allow",
        "git push": "ask",
        "rm *": "deny",
      },
      read: "allow",
    });
    assert.deepEqual(result.output, {
      bash: {
        patterns: [
          { match: "git status", approval: "allow" },
          { match: "git push", approval: "prompt" },
          { match: "rm *", approval: "deny" },
        ],
      },
    });
    assert.deepEqual(convert("opencode", "omp", { read: "allow" }).output, {
      bash: { patterns: [] },
    });
  });

  void it("converts OMP in both directions", () => {
    const native = {
      bash: {
        patterns: [
          { match: "git status", approval: "allow" },
          { match: "git push", approval: "prompt" },
          { match: "rm *", approval: "deny" },
        ],
      },
    };
    const canonical = convert("omp", "canonical", native);
    assert.equal(canonical.from, "omp");
    assert.ok(
      typeof canonical.output === "object" &&
        canonical.output !== null &&
        "rules" in canonical.output,
    );
    assert.deepEqual(canonical.output.rules, [
      { tool: "Bash", pattern: "git status", tier: "allow" },
      { tool: "Bash", pattern: "git push", tier: "ask" },
      { tool: "Bash", pattern: "rm *", tier: "deny" },
    ]);
    assert.deepEqual(
      convert("canonical", "omp", canonical.output).output,
      native,
    );
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

void describe("validate", () => {
  void it("returns valid for a correct policy", () => {
    const result = validate({ rules: [{ tool: "Bash", tier: "allow" }] });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  void it("returns invalid for a bad policy", () => {
    const result = validate({ rules: [{ tool: "Bash", tier: "maybe" }] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  void it("returns invalid for empty object", () => {
    // Empty object is actually valid — all fields are optional
    const result = validate({});
    assert.equal(result.valid, true);
  });

  void it("includes path and message in errors", () => {
    const result = validate({ rules: "not an array" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    const first = result.errors[0];
    assert.ok(first !== undefined);
    assert.ok(first.path.length > 0);
    assert.ok(first.message.length > 0);
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

void describe("check", () => {
  void it("allows a matching rule", () => {
    const result = check("Bash", "git status", {
      rules: [{ tool: "Bash", pattern: "git status", tier: "allow" }],
    });
    assert.equal(result.decision, "allow");
  });

  void it("denies a matching deny rule", () => {
    const result = check("Bash", "sudo rm -rf /", {
      rules: [{ tool: "Bash", pattern: "sudo:*", tier: "deny" }],
    });
    assert.equal(result.decision, "deny");
  });

  void it("falls back to defaultMode", () => {
    const result = check("Bash", "unknown command", {
      rules: [{ tool: "Bash", pattern: "git status", tier: "allow" }],
      defaultMode: "readonly",
    });
    assert.equal(result.decision, "deny");
  });

  void it("passes context through", () => {
    const result = check(
      "Bash",
      "npm publish",
      {
        rules: [
          {
            tool: "Bash",
            pattern: "npm publish",
            tier: "deny",
            when: { branch: "main" },
          },
        ],
      },
      { branch: "main" },
    );
    assert.equal(result.decision, "deny");
  });

  void it("skips conditional rules when context doesn't match", () => {
    const result = check(
      "Bash",
      "npm publish",
      {
        rules: [
          {
            tool: "Bash",
            pattern: "npm publish",
            tier: "deny",
            when: { branch: "main" },
          },
        ],
      },
      { branch: "feature" },
    );
    assert.equal(result.decision, "ask");
  });

  void it("throws on invalid policy", () => {
    assert.throws(
      () => check("Bash", "test", { rules: [{ tool: "Bash", tier: "maybe" }] }),
      ConvertError,
    );
  });
});
