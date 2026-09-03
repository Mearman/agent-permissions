/**
 * Tests that the evaluator's pattern matching is trilean's compiled output, not a local copy of the same dialect.
 *
 * Behavioural parity with the previous hand-rolled implementation is already covered by evaluate.test.ts and evaluate-advanced.test.ts, and parity alone cannot tell the two apart — a second, drifting copy would pass those too. These tests pin the delegation itself: the node shape the evaluator reads its regex out of, the fact that the regex governing a decision is byte-for-byte the one trilean's builder emits, and one input whose outcome the previous local compiler could not have produced.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hierarchicalGlobPattern,
  prefixPattern,
  wildcardPattern,
} from "trilean/derived-patterns";
import type { ExpressionNode, PredicateNode } from "trilean/tree";

import { evaluate, type PermissionPolicy } from "../evaluate.ts";

const SUBJECT: ExpressionNode = { kind: "reference", key: "subject" };

/** The same extraction src/evaluate.ts performs, so a shape change fails here rather than at runtime. */
function compiledPattern(node: PredicateNode): string {
  assert.equal(node.kind, "textCompare");
  assert.equal(node.op, "matches");
  assert.equal(node.right.kind, "textLiteral");
  return node.right.value;
}

function bashPolicy(pattern: string): PermissionPolicy {
  return {
    defaultMode: "standard",
    rules: [{ tool: "Bash", pattern, tier: "allow" }],
  };
}

void describe("trilean pattern-builder delegation", () => {
  void describe("node contract the evaluator reads through", () => {
    void it("every builder returns a textCompare/matches node over a textLiteral", () => {
      for (const node of [
        prefixPattern(SUBJECT, "npm"),
        wildcardPattern(SUBJECT, "git * status"),
        hierarchicalGlobPattern(SUBJECT, "src/**/*.ts"),
      ]) {
        assert.equal(typeof compiledPattern(node), "string");
      }
    });

    void it("compiles to trilean's flag-independent spellings, not the previous local ones", () => {
      // `[\s\S]*` rather than `.*`, and `[^\/]*` rather than `[^/]*` — the compiled string carries no flags of its own, so it has to mean "any character" and "any character in one segment" without relying on `s` or on `/` being legal unescaped inside a `v`-mode class.
      assert.equal(
        compiledPattern(wildcardPattern(SUBJECT, "git * status")),
        String.raw`^git [\s\S]* status$`,
      );
      assert.equal(
        compiledPattern(prefixPattern(SUBJECT, "npm")),
        String.raw`^npm(?: [\s\S]*)?$`,
      );
      assert.equal(
        compiledPattern(hierarchicalGlobPattern(SUBJECT, "src/*.ts")),
        String.raw`^src\/[^\/]*\.ts$`,
      );
    });
  });

  void describe("decisions follow the builder's own compiled regex", () => {
    const wildcardCases: readonly (readonly [string, string])[] = [
      ["git *", "git"],
      ["git *", "git add file"],
      ["git * *", "git"],
      ["git * *", "git add file"],
      [String.raw`echo \*`, "echo *"],
      [String.raw`echo \*`, "echo hello"],
      ["find \\\\", "find \\"],
      ["npm run *", "npm run build"],
      ["deploy *", "deploy prod\n--force"],
      ["a.b*", "a.bc"],
      ["a.b*", "axbc"],
    ];

    for (const [pattern, input] of wildcardCases) {
      void it(`wildcard ${JSON.stringify(pattern)} vs ${JSON.stringify(input)}`, () => {
        const expected = new RegExp(
          compiledPattern(wildcardPattern(SUBJECT, pattern)),
        ).test(input)
          ? "allow"
          : "ask";
        assert.equal(evaluate(bashPolicy(pattern), "bash", input), expected);
      });
    }

    const prefixCases: readonly (readonly [string, string])[] = [
      ["git", "git"],
      ["git", "git status"],
      ["git", "gitk"],
      ["npm run", "npm run build"],
      ["a.b", "axb"],
    ];

    for (const [prefix, input] of prefixCases) {
      void it(`prefix ${JSON.stringify(prefix)} vs ${JSON.stringify(input)}`, () => {
        const expected = new RegExp(
          compiledPattern(prefixPattern(SUBJECT, prefix)),
        ).test(input)
          ? "allow"
          : "ask";
        assert.equal(
          evaluate(bashPolicy(`${prefix}:*`), "bash", input),
          expected,
        );
      });
    }

    const globCases: readonly (readonly [string, string])[] = [
      ["/repo/*", "/repo/pkg"],
      ["/repo/*", "/repo/pkg/src"],
      ["/repo/**", "/repo/pkg/src"],
      ["/repo/?", "/repo/a"],
      ["/repo/?", "/repo/ab"],
      ["/repo/a.b/**", "/repo/axb/src"],
    ];

    for (const [pattern, cwd] of globCases) {
      void it(`cwd glob ${JSON.stringify(pattern)} vs ${JSON.stringify(cwd)}`, () => {
        const expected = new RegExp(
          compiledPattern(hierarchicalGlobPattern(SUBJECT, pattern)),
        ).test(cwd)
          ? "allow"
          : "ask";
        const policy: PermissionPolicy = {
          defaultMode: "standard",
          rules: [{ tool: "Read", tier: "allow", when: { cwd: pattern } }],
        };
        assert.equal(evaluate(policy, "read", "anything", { cwd }), expected);
      });
    }
  });

  void describe("outcomes the previous local compiler could not produce", () => {
    void it("`**` spans a line terminator, matching the flat wildcard dialect", () => {
      // The local implementation compiled `**` to `.*` and ran it with no `s` flag, so a path or branch containing a newline fell out of a `**` match while the sibling wildcard dialect (run with `s`) matched one. trilean compiles both to `[\s\S]*`, so the two agree.
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Read", tier: "allow", when: { cwd: "/repo/**" } }],
      };
      assert.equal(
        new RegExp(String.raw`^/repo/.*$`).test("/repo/a\nb"),
        false,
        "the previous local compilation of `**` did not span a newline",
      );
      assert.equal(
        evaluate(policy, "read", "anything", { cwd: "/repo/a\nb" }),
        "allow",
      );
    });

    void it("a glob containing the previous compiler's own placeholder text matches literally", () => {
      // The local implementation compiled the hierarchical glob by successive `String.replace` passes, parking `**` in a `⟪DOUBLESTAR⟫` placeholder and substituting it back at the end. A pattern that already contained that text was therefore rewritten by the restoring pass as though the author had written `**`, silently widening a rule far past the directory it names: `⟪DOUBLESTAR⟫/*` compiled to `^.*/[^/]*$` and matched `/etc/passwd`. trilean compiles in one left-to-right pass with no placeholder to collide with, so the text is escaped as the literal it is and matches only itself.
      const pattern = "⟪DOUBLESTAR⟫/*";
      const policy: PermissionPolicy = {
        defaultMode: "standard",
        rules: [{ tool: "Read", tier: "allow", when: { cwd: pattern } }],
      };
      assert.equal(
        new RegExp(String.raw`^.*/[^/]*$`).test("/etc/passwd"),
        true,
        "the previous local compilation of this pattern matched any single-segment path",
      );
      assert.equal(
        evaluate(policy, "read", "anything", { cwd: "/etc/passwd" }),
        "ask",
      );
      assert.equal(
        evaluate(policy, "read", "anything", {
          cwd: "⟪DOUBLESTAR⟫/x",
        }),
        "allow",
      );
    });
  });
});
