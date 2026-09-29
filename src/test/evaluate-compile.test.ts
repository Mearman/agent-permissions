/** A compiled policy parses its patterns once and decides exactly as `evaluate` does. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compile, evaluate, type PermissionPolicy } from "../evaluate.ts";

const policy: PermissionPolicy = {
  defaultMode: "standard",
  rules: [
    { tool: "Bash", pattern: "git:*", tier: "allow" },
    { tool: "Bash", pattern: "npm run *", tier: "allow" },
    { tool: "Bash", pattern: "curl:*", tier: "deny" },
    { tool: "Bash", pattern: "git push:*", tier: "ask" },
    { tool: "Read", pattern: "./secrets/**", tier: "deny" },
    { tool: "Write", pattern: "./src/**", tier: "allow" },
    { tool: "mcp__github__*", tier: "ask" },
    {
      tool: "Edit",
      pattern: "./infra/*",
      tier: "deny",
      when: { cwd: "./packages/*" },
    },
  ],
};

const calls: [string, string, { cwd?: string; branch?: string }?][] = [
  ["Bash", "git status"],
  ["Bash", "git push origin main"],
  ["Bash", "git status && curl x"],
  ["Bash", "npm run build"],
  ["Bash", "echo $(curl x)"],
  ["Bash", "git status # more"],
  ["Bash", ""],
  ["bash", "ls"],
  ["Read", "./secrets/key"],
  ["Read", "./src/a.ts"],
  ["Write", "./src/a.ts"],
  ["Write", "./dist/a.ts"],
  ["mcp__github__create_issue", ""],
  ["mcp__other__tool", ""],
  ["Edit", "./infra/a", { cwd: "./packages/x" }],
  ["Edit", "./infra/a", { cwd: "./other" }],
  ["Edit", "./infra/a", {}],
];

void describe("compile", () => {
  void it("decides exactly as evaluate does", () => {
    const compiled = compile(policy);
    for (const [tool, input, ctx] of calls) {
      assert.equal(
        compiled.evaluate(tool, input, ctx),
        evaluate(policy, tool, input, ctx),
        `${tool} ${input}`,
      );
    }
  });

  void it("explains exactly as explain does", () => {
    const compiled = compile(policy);
    assert.deepEqual(
      compiled
        .explain("Bash", "git status && curl x")
        .steps.map((s) => [s.command, s.decision]),
      [
        ["git status", "allow"],
        ["curl x", "deny"],
      ],
    );
  });

  void it("builds no regular expression after each rule has been used once", () => {
    const compiled = compile(policy);
    const warmUp = (): void => {
      for (const [tool, input, ctx] of calls) {
        compiled.evaluate(tool, input, ctx);
      }
    };
    warmUp();

    const NativeRegExp = globalThis.RegExp;
    let built = 0;
    globalThis.RegExp = class extends NativeRegExp {
      constructor(...args: ConstructorParameters<typeof NativeRegExp>) {
        super(...args);
        built += 1;
      }
    } as RegExpConstructor;
    try {
      for (let i = 0; i < 50; i++) warmUp();
    } finally {
      globalThis.RegExp = NativeRegExp;
    }
    assert.equal(built, 0);
  });
});
