/** Replaying a policy over a recorded session, and proposing allow rules from it. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluate, type PermissionPolicy } from "../evaluate.ts";
import {
  parseTranscript,
  replayCalls,
  suggestRules,
  type ToolCall,
} from "../replay.ts";
import { replay, suggest } from "../api.ts";
import type { Rule } from "../schema.ts";
import {
  bash,
  jsonl,
  REJECTED_TEXT,
  toolResult,
  toolUse,
} from "./transcript-fixture.ts";

const HERE = { cwd: "/work/example", branch: "main" };

function call(
  subject: string,
  outcome?: ToolCall["outcome"],
  tool = "Bash",
): ToolCall {
  return {
    tool,
    subject,
    context: HERE,
    ...(outcome === undefined ? {} : { outcome }),
  };
}

const standard: PermissionPolicy = { defaultMode: "standard", rules: [] };

void describe("parseTranscript", () => {
  void it("reads each tool call with its subject, context and recorded outcome", () => {
    const text = jsonl([
      ...bash("t1", "git status", "ran"),
      ...bash("t2", "rm -rf build", "denied"),
      ...bash("t3", "curl https://example.com", "rejected"),
      toolUse("t4", "Read", { file_path: "/work/example/a.ts" }),
      toolResult("t4", [{ type: "text", text: "contents" }]),
      toolUse("t5", "mcp__example__lookup", { query: "q" }),
    ]);
    assert.deepEqual(parseTranscript(text), [
      { tool: "Bash", subject: "git status", context: HERE, outcome: "ran" },
      {
        tool: "Bash",
        subject: "rm -rf build",
        context: HERE,
        outcome: "denied",
      },
      {
        tool: "Bash",
        subject: "curl https://example.com",
        context: HERE,
        outcome: "rejected",
      },
      {
        tool: "Read",
        subject: "/work/example/a.ts",
        context: HERE,
        outcome: "ran",
      },
      { tool: "mcp__example__lookup", context: HERE },
    ]);
  });

  void it("reads a rejection recorded as a list of text blocks", () => {
    const text = jsonl([
      toolUse("t1", "Write", { file_path: "/work/example/b.ts", content: "x" }),
      toolResult("t1", [{ type: "text", text: REJECTED_TEXT }], true),
    ]);
    assert.equal(parseTranscript(text)[0]?.outcome, "rejected");
  });

  void it("treats a failed call that was not refused as having run", () => {
    const text = jsonl([
      toolUse("t1", "Bash", { command: "false" }),
      toolResult("t1", "Exit code 1", true),
    ]);
    assert.equal(parseTranscript(text)[0]?.outcome, "ran");
  });

  void it("leaves out context the transcript does not record", () => {
    const text = jsonl([
      toolUse("t1", "Bash", { command: "ls" }, {}),
      toolResult("t1", "ok", false, {}),
    ]);
    assert.deepEqual(parseTranscript(text), [
      { tool: "Bash", subject: "ls", context: {}, outcome: "ran" },
    ]);
  });

  void it("rejects a line that is not JSON, naming the line", () => {
    assert.throws(
      () => parseTranscript(jsonl(bash("t1", "ls", "ran")) + "{oops\n"),
      /line 3/,
    );
  });
});

void describe("replayCalls", () => {
  const policy: PermissionPolicy = {
    defaultMode: "standard",
    rules: [
      { tool: "Bash", pattern: "git:*", tier: "allow" },
      { tool: "Bash", pattern: "curl:*", tier: "allow" },
      { tool: "Bash", pattern: "rm:*", tier: "deny" },
      {
        tool: "Bash",
        pattern: "npm test",
        tier: "allow",
        when: { branch: "main" },
      },
    ],
  };

  void it("counts decisions and lists the calls the transcript recorded differently", () => {
    const report = replayCalls(policy, [
      call("git status", "ran"),
      call("npm test", "ran"),
      call("rm -rf build", "ran"),
      call("curl https://example.com", "rejected"),
      call("ls", "rejected"),
      call("git log", "denied"),
      call("make"),
    ]);
    assert.deepEqual(report.counts, { allow: 4, ask: 2, deny: 1 });
    assert.deepEqual(
      report.differing.map((r) => [r.decision, r.call.outcome, r.call.subject]),
      [
        ["deny", "ran", "rm -rf build"],
        ["allow", "rejected", "curl https://example.com"],
        ["allow", "denied", "git log"],
      ],
    );
  });

  void it("judges a conditional rule by the context recorded with the call", () => {
    const report = replayCalls(policy, [
      { tool: "Bash", subject: "npm test", context: { branch: "feature" } },
      { tool: "Bash", subject: "npm test", context: {} },
    ]);
    assert.deepEqual(report.counts, { allow: 0, ask: 2, deny: 0 });
  });

  void it("judges each command of a shell line", () => {
    const report = replayCalls(policy, [call("git status && rm x", "ran")]);
    assert.deepEqual(report.counts, { allow: 0, ask: 0, deny: 1 });
    assert.deepEqual(
      report.differing[0]?.steps.map((s) => [s.command, s.decision]),
      [
        ["git status", "allow"],
        ["rm x", "deny"],
      ],
    );
  });
});

/** Whether `rule` on its own matches `subject` for `tool`. */
function covers(rule: Rule, tool: string, subject: string): boolean {
  return (
    evaluate({ defaultMode: "readonly", rules: [rule] }, tool, subject) ===
    "allow"
  );
}

void describe("suggestRules", () => {
  void it("proposes an exact rule for a command approved repeatedly", () => {
    const suggestions = suggestRules(
      [call("git status", "ran"), call("git status", "ran"), call("ls", "ran")],
      standard,
      2,
    );
    assert.deepEqual(suggestions, [
      {
        rule: { tool: "Bash", pattern: "git status", tier: "allow" },
        count: 2,
      },
    ]);
  });

  void it("proposes the longest shared prefix for varied commands", () => {
    const suggestions = suggestRules(
      [
        call("npm run build", "ran"),
        call("npm run test --watch", "ran"),
        call("npm run lint", "ran"),
      ],
      standard,
      2,
    );
    assert.deepEqual(suggestions, [
      {
        rule: { tool: "Bash", pattern: "npm run:*", tier: "allow" },
        count: 3,
      },
    ]);
  });

  void it("counts each command of a shell line on its own", () => {
    const suggestions = suggestRules(
      [call("git status && ls", "ran"), call("ls | wc -l", "ran")],
      standard,
      2,
    );
    assert.deepEqual(suggestions, [
      { rule: { tool: "Bash", pattern: "ls", tier: "allow" }, count: 2 },
    ]);
  });

  void it("never proposes a command that shared a line with a command a rule denied", () => {
    const policy: PermissionPolicy = {
      defaultMode: "standard",
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    };
    const suggestions = suggestRules(
      [
        call("ls", "ran"),
        call("ls", "ran"),
        call("ls && rm -rf build"),
        call("pwd", "ran"),
        call("pwd", "ran"),
      ],
      policy,
      2,
    );
    assert.deepEqual(suggestions, [
      { rule: { tool: "Bash", pattern: "pwd", tier: "allow" }, count: 2 },
    ]);
  });

  void it("never proposes a command the transcript recorded as refused", () => {
    const suggestions = suggestRules(
      [
        call("cat a.txt", "ran"),
        call("cat a.txt", "ran"),
        call("cat b.txt", "ran"),
        call("cat c.txt && echo x", "rejected"),
        call("echo x", "ran"),
        call("echo x", "ran"),
      ],
      standard,
      2,
    );
    // A `cat:*` prefix would also allow the refused `cat c.txt`, so only the repeated exact command is proposed.
    assert.deepEqual(suggestions, [
      { rule: { tool: "Bash", pattern: "cat a.txt", tier: "allow" }, count: 2 },
    ]);
  });

  void it("leaves out what the policy already allows", () => {
    const policy: PermissionPolicy = {
      defaultMode: "standard",
      rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
    };
    const suggestions = suggestRules(
      [call("git status", "ran"), call("git status", "ran")],
      policy,
      2,
    );
    assert.deepEqual(suggestions, []);
  });

  void it("proposes exact rules for other tools, and bare rules for tools with no subject", () => {
    const lookup: ToolCall = {
      tool: "mcp__example__lookup",
      context: HERE,
      outcome: "ran",
    };
    const suggestions = suggestRules(
      [
        call("/work/example/a.ts", "ran", "Read"),
        call("/work/example/a.ts", "ran", "Read"),
        call("/work/example/b.ts", "ran", "Read"),
        lookup,
        lookup,
      ],
      standard,
      2,
    );
    assert.deepEqual(suggestions, [
      {
        rule: { tool: "Read", pattern: "/work/example/a.ts", tier: "allow" },
        count: 2,
      },
      { rule: { tool: "mcp__example__lookup", tier: "allow" }, count: 2 },
    ]);
  });

  void it("escapes pattern syntax so the rule matches the command literally", () => {
    const suggestions = suggestRules(
      [call("ls *.ts", "ran"), call("ls *.ts", "ran")],
      standard,
      2,
    );
    assert.equal(suggestions.length, 1);
    const [only] = suggestions;
    assert.ok(only);
    assert.ok(covers(only.rule, "Bash", "ls *.ts"));
    assert.ok(!covers(only.rule, "Bash", "ls secret.env"));
  });

  void it("skips shell lines the splitter cannot model", () => {
    const suggestions = suggestRules(
      [call("(cd x && ls)", "ran"), call("(cd x && ls)", "ran")],
      standard,
      2,
    );
    assert.deepEqual(suggestions, []);
  });
});

void describe("api replay and suggest", () => {
  const transcript = jsonl([
    ...bash("t1", "git status", "ran"),
    ...bash("t2", "git status", "ran"),
    ...bash("t3", "sudo reboot", "ran"),
  ]);

  void it("replays a canonical policy over a transcript", () => {
    const report = replay(
      { permissions: { allow: ["Bash(git:*)"], deny: ["Bash(sudo:*)"] } },
      transcript,
    );
    assert.deepEqual(report.counts, { allow: 2, ask: 0, deny: 1 });
    assert.deepEqual(
      report.differing.map((r) => r.call.subject),
      ["sudo reboot"],
    );
  });

  void it("suggests rules with or without a policy", () => {
    assert.deepEqual(suggest(transcript, { minCount: 2 }), [
      {
        rule: { tool: "Bash", pattern: "git status", tier: "allow" },
        count: 2,
      },
    ]);
    assert.deepEqual(
      suggest(transcript, {
        minCount: 2,
        policy: { rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }] },
      }),
      [],
    );
  });
});
