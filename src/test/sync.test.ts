import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { UnsupportedCapabilityError } from "../compat/unsupported.ts";
import { computeWriteTargets } from "../sync.ts";

void describe("computeWriteTargets", () => {
  type Agent = "claude-code" | "codex" | "kiro" | "opencode" | "crush" | "omp";
  const rule = { tool: "Bash", pattern: "rm:*", tier: "deny" } as const;

  /** An encoder table where each agent encodes to an empty config unless told to throw. */
  function encoders(
    refusals: Partial<Record<Agent, () => never>>,
  ): Record<Agent, { encode: () => unknown }> {
    const encoderFor = (agent: Agent): { encode: () => unknown } => ({
      encode: (): unknown => {
        refusals[agent]?.();
        return { permissions: {} };
      },
    });
    return {
      "claude-code": encoderFor("claude-code"),
      codex: encoderFor("codex"),
      kiro: encoderFor("kiro"),
      opencode: encoderFor("opencode"),
      crush: encoderFor("crush"),
      omp: encoderFor("omp"),
    };
  }

  void it("reports an agent whose codec refuses the policy instead of skipping it", () => {
    const refusal = new UnsupportedCapabilityError("opencode", [
      { rule, reason: "no equivalent" },
    ]);
    const { targets, refused } = computeWriteTargets(
      tmpdir(),
      { rules: [rule] },
      [],
      undefined,
      true,
      encoders({
        opencode: () => {
          throw refusal;
        },
      }),
    );
    assert.deepEqual(refused, [refusal]);
    assert.equal(
      targets.some((t) => t.agent === "opencode"),
      false,
    );
  });

  void it("lets an unexpected error from a codec through", () => {
    assert.throws(
      () =>
        computeWriteTargets(
          tmpdir(),
          { rules: [rule] },
          [],
          undefined,
          true,
          encoders({
            kiro: () => {
              throw new TypeError("a bug in the codec");
            },
          }),
        ),
      TypeError,
    );
  });
});
