/** Codecs other than Codex and OMP never write a rule weaker than it was, and say when they cannot write it. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  claudeCodeCodec,
  codexCodec,
  crushCodec,
  kiroCodec,
  opencodeCodec,
} from "../compat/codecs.ts";
import { UnsupportedCapabilityError } from "../compat/unsupported.ts";
import { evaluate, mapMode, mostRestrictiveMode } from "../evaluate.ts";
import type { AgentPermissionPolicy, Rule } from "../schema.ts";

const refuses = (
  encode: () => unknown,
  count = 1,
): UnsupportedCapabilityError => {
  try {
    encode();
  } catch (e) {
    assert.ok(e instanceof UnsupportedCapabilityError, String(e));
    assert.equal(e.unsupported.length, count);
    return e;
  }
  throw new assert.AssertionError({ message: "expected a refusal" });
};

void describe("dontAsk is a deny, not an allow", () => {
  void it("denies what no rule covers, as Claude Code's dontAsk does", () => {
    assert.equal(mapMode("dontAsk"), "readonly");
    assert.equal(
      evaluate({ defaultMode: mapMode("dontAsk"), rules: [] }, "Bash", "ls"),
      "deny",
    );
    assert.equal(
      evaluate(
        {
          defaultMode: mapMode("dontAsk"),
          rules: [{ tool: "Bash", pattern: "ls", tier: "allow" }],
        },
        "Bash",
        "ls",
      ),
      "allow",
    );
  });

  void it("is the most restrictive mode when modes are merged", () => {
    assert.equal(mostRestrictiveMode("dontAsk", "standard"), "dontAsk");
    assert.equal(mostRestrictiveMode("standard", "dontAsk"), "dontAsk");
  });

  void it("is not written to Codex as a mode that never asks", () => {
    const encoded = codexCodec.encode({ defaultMode: "dontAsk" });
    assert.notEqual(encoded.approval_policy, "never");
  });
});

void describe("claude-code encode", () => {
  void it("leaves out an allow limited by a condition, which would otherwise apply everywhere", () => {
    const encoded = claudeCodeCodec.encode({
      rules: [
        {
          tool: "Bash",
          pattern: "npm run *",
          tier: "allow",
          when: { cwd: "./packages/*" },
        },
      ],
    });
    assert.deepEqual(encoded, {});
  });

  void it("keeps a conditional deny or ask, applying it unconditionally, which is stricter", () => {
    const encoded = claudeCodeCodec.encode({
      rules: [
        {
          tool: "Bash",
          pattern: "rm:*",
          tier: "deny",
          when: { branch: "main" },
        },
        {
          tool: "Bash",
          pattern: "git push:*",
          tier: "ask",
          when: { env: { CI: "1" } },
        },
      ],
    });
    assert.deepEqual(encoded.deny, ["Bash(rm:*)"]);
    assert.deepEqual(encoded.ask, ["Bash(git push:*)"]);
  });

  void it("leaves out an allow limited by a predicate and writes a deny or ask without it", () => {
    const predicate = {
      kind: "not",
      operand: {
        kind: "textCompare",
        op: "equals",
        left: { kind: "reference", key: "env:STAGE" },
        right: { kind: "textLiteral", value: "prod" },
      },
    };
    const encoded = claudeCodeCodec.encode({
      defaultMode: "standard",
      rules: [
        {
          tool: "Bash",
          pattern: "deploy:*",
          tier: "allow",
          when: { predicate },
        },
        { tool: "Bash", pattern: "rm:*", tier: "deny", when: { predicate } },
      ],
    });
    assert.deepEqual(encoded.allow, []);
    assert.deepEqual(encoded.deny, ["Bash(rm:*)"]);
  });

  void it("writes a mode Claude Code has no name for as the closest one that is not looser", () => {
    assert.equal(
      claudeCodeCodec.encode({ defaultMode: "readonly" }).defaultMode,
      "dontAsk",
    );
    assert.equal(
      claudeCodeCodec.encode({ defaultMode: "restricted" }).defaultMode,
      "default",
    );
    assert.equal(
      claudeCodeCodec.encode({ defaultMode: "standard" }).defaultMode,
      "default",
    );
  });

  void it("writes none for a mode that asks for nothing", () => {
    assert.equal(
      claudeCodeCodec.encode({ defaultMode: "autonomous" }).defaultMode,
      undefined,
    );
  });

  void it("keeps the modes it already names", () => {
    assert.equal(
      claudeCodeCodec.encode({ defaultMode: "plan" }).defaultMode,
      "plan",
    );
    assert.equal(
      claudeCodeCodec.encode({ defaultMode: "dontAsk" }).defaultMode,
      "dontAsk",
    );
  });
});

void describe("crush encode", () => {
  void it("refuses a deny or ask, since Crush has only an allowlist", () => {
    refuses(() =>
      crushCodec.encode({ rules: [{ tool: "Bash", tier: "deny" }] }),
    );
    refuses(() =>
      crushCodec.encode({
        rules: [{ tool: "Read", pattern: "./x", tier: "ask" }],
      }),
    );
  });

  void it("lists every refused rule", () => {
    refuses(
      () =>
        crushCodec.encode({
          rules: [
            { tool: "Bash", tier: "deny" },
            { tool: "Read", tier: "allow" },
            { tool: "Write", pattern: "./a", tier: "deny" },
          ],
        }),
      2,
    );
  });

  void it("still writes a bare allow and leaves out a patterned one", () => {
    assert.deepEqual(
      crushCodec.encode({
        rules: [
          { tool: "Read", tier: "allow" },
          { tool: "Bash", pattern: "git:*", tier: "allow" },
        ],
      }),
      { allowed_tools: ["view"] },
    );
  });
});

void describe("opencode encode", () => {
  void it("refuses a deny or ask for a tool it has no name for, and leaves out an allow", () => {
    refuses(() =>
      opencodeCodec.encode({
        rules: [{ tool: "mcp__github__x", tier: "deny" }],
      }),
    );
    refuses(() =>
      opencodeCodec.encode({ rules: [{ tool: "NotebookEdit", tier: "ask" }] }),
    );
    assert.doesNotThrow(() =>
      opencodeCodec.encode({
        rules: [{ tool: "mcp__github__x", tier: "allow" }],
      }),
    );
  });

  void it("keeps the stricter tier when two rules share a pattern", () => {
    const rules: Rule[] = [
      { tool: "Bash", pattern: "git push:*", tier: "deny" },
      { tool: "Bash", pattern: "git push:*", tier: "allow" },
    ];
    const bashOf = (encoded: unknown): unknown =>
      typeof encoded === "object" && encoded !== null && "bash" in encoded
        ? encoded.bash
        : undefined;
    assert.deepEqual(bashOf(opencodeCodec.encode({ rules })), {
      "git push *": "deny",
    });
    assert.deepEqual(
      bashOf(opencodeCodec.encode({ rules: [...rules].reverse() })),
      {
        "git push *": "deny",
      },
    );
  });
});

void describe("kiro encode", () => {
  const policy = (rule: Rule): AgentPermissionPolicy => ({ rules: [rule] });

  void it("refuses an ask, which Kiro has no setting for", () => {
    refuses(() =>
      kiroCodec.encode(
        policy({ tool: "Bash", pattern: "git push:*", tier: "ask" }),
      ),
    );
  });

  void it("refuses a deny with no pattern and a deny for a tool it has no setting for", () => {
    refuses(() => kiroCodec.encode(policy({ tool: "Bash", tier: "deny" })));
    refuses(() =>
      kiroCodec.encode(policy({ tool: "Grep", pattern: "x", tier: "deny" })),
    );
  });

  void it("still writes a patterned deny it can express", () => {
    const encoded = kiroCodec.encode(
      policy({ tool: "Read", pattern: "./secrets", tier: "deny" }),
    );
    assert.deepEqual(encoded.toolsSettings?.read?.deniedPaths, ["./secrets"]);
  });
});
