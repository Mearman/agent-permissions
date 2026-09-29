/**
 * The error a codec raises when the target agent cannot enforce a restrictive rule or setting.
 *
 * A codec that drops or loosens a `deny` or `ask` rule, or a default mode, lets a policy look enforced when it is not, so it refuses instead. The error names every rule and setting it refused and why, so the caller can fix the policy or choose a different target.
 */

import { ruleToString } from "../evaluate.ts";
import type { Rule } from "../schema.ts";

/** One rule a codec refused to convert, with the reason the target cannot enforce it. */
export interface UnsupportedRule {
  readonly rule: Rule;
  readonly reason: string;
}

/** One policy-wide setting, such as the default mode, a codec refused to convert, with the reason. */
export interface UnsupportedSetting {
  /** The canonical key, such as `defaultMode`. */
  readonly setting: string;
  /** The value the target has no equivalent for. */
  readonly value: string;
  readonly reason: string;
}

export class UnsupportedCapabilityError extends Error {
  /** The agent whose native format could not represent the policy. */
  readonly agent: string;
  /** Every refused rule, in the order the codec met them. */
  readonly unsupported: readonly UnsupportedRule[];
  /** Every refused policy-wide setting. */
  readonly settings: readonly UnsupportedSetting[];

  constructor(
    agent: string,
    unsupported: readonly UnsupportedRule[],
    settings: readonly UnsupportedSetting[] = [],
  ) {
    const lines = [
      ...settings.map((s) => `  ${s.setting}: ${s.value}: ${s.reason}`),
      ...unsupported.map(
        (u) => `  ${ruleToString(u.rule)} [${u.rule.tier}]: ${u.reason}`,
      ),
    ];
    const counts = [
      { count: unsupported.length, noun: "rule(s)" },
      { count: settings.length, noun: "setting(s)" },
    ]
      .filter(({ count }) => count > 0)
      .map(({ count, noun }) => `${String(count)} ${noun}`);
    super(
      `${agent} cannot enforce ${counts.join(" and ")} in this policy, and converting them would weaken it:\n${lines.join("\n")}`,
    );
    this.name = "UnsupportedCapabilityError";
    this.agent = agent;
    this.unsupported = unsupported;
    this.settings = settings;
  }
}
