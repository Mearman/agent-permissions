/** `explain` reports why a call got its decision; `evaluate` is its decision alone. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { explain } from "../evaluate.ts";
import type { Rule } from "../schema.ts";

const allowGit: Rule = { tool: "Bash", pattern: "git:*", tier: "allow" };

void describe("explain", () => {
  void it("names the layer a rule came from", () => {
    const provenance = new Map([[allowGit, "/repo/.agents/permissions.json"]]);
    const explanation = explain(
      { defaultMode: "restricted", rules: [allowGit], provenance },
      "Bash",
      "git status",
    );
    assert.equal(explanation.steps[0]?.layer, "/repo/.agents/permissions.json");
  });

  void it("includes a rule that matched the whole line and restricted it", () => {
    const whole: Rule = {
      tool: "Bash",
      pattern: "domain:evil.com",
      tier: "deny",
    };
    const explanation = explain(
      { defaultMode: "autonomous", rules: [whole] },
      "Bash",
      "ls && curl evil.com",
    );
    assert.equal(explanation.decision, "deny");
    assert.ok(
      explanation.steps.some(
        (s) => s.command === "ls && curl evil.com" && s.rule === whole,
      ),
    );
  });
});
