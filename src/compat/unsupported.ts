/**
 * The error a codec raises when the target agent cannot enforce a restrictive rule.
 *
 * A codec that drops or loosens a `deny` or `ask` rule lets a policy look enforced when it is not,
 * so it refuses instead. The error names every rule it refused and why, so the caller can fix the
 * policy or choose a different target.
 */

import { ruleToString } from "../evaluate.ts";
import type { Rule } from "../schema.ts";

/** One rule a codec refused to convert, with the reason the target cannot enforce it. */
export interface UnsupportedRule {
  readonly rule: Rule;
  readonly reason: string;
}

export class UnsupportedCapabilityError extends Error {
  /** The agent whose native format could not represent the policy. */
  readonly agent: string;
  /** Every refused rule, in the order the codec met them. */
  readonly unsupported: readonly UnsupportedRule[];

  constructor(agent: string, unsupported: readonly UnsupportedRule[]) {
    const lines = unsupported.map(
      (u) => `  ${ruleToString(u.rule)} [${u.rule.tier}]: ${u.reason}`,
    );
    super(
      `${agent} cannot enforce ${String(unsupported.length)} rule(s) in this policy, and converting them would weaken it:\n${lines.join("\n")}`,
    );
    this.name = "UnsupportedCapabilityError";
    this.agent = agent;
    this.unsupported = unsupported;
  }
}
