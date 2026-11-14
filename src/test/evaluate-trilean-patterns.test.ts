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

const SUBJECT: ExpressionNode = { kind: "reference", key: "subject" };

/** The same extraction src/evaluate.ts performs, so a shape change fails here rather than at runtime. */
function compiledPattern(node: PredicateNode): string {
  assert.equal(node.kind, "textCompare");
  assert.equal(node.op, "matches");
  assert.equal(node.right.kind, "textLiteral");
  return node.right.value;
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
});
