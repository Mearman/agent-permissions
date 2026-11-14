import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convert } from "../api.ts";

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

  void it("throws on undetectable format", () => {
    assert.throws(() => convert(undefined, "canonical", { foo: "bar" }), Error);
  });
});
