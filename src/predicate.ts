/**
 * `when.predicate`: a trilean predicate tree over the evaluation context.
 *
 * The tree is validated with trilean's own schema and evaluated with trilean's synchronous evaluator, so it follows the same three-valued rules as every other condition: a field the context does not carry is indeterminate, an indeterminate condition restricts a deny or ask rule and never satisfies an allow rule, and a definite result on one branch settles an `or` or `and` whatever the other branch is.
 */

import { createSyncEvaluator } from "trilean/evaluator-factory";
import type { Evaluation } from "trilean/evaluation";
import type { Resolution, SyncResolvers } from "trilean/resolvers";
import { PredicateNodeSchema, type PredicateNode } from "trilean/tree";

import type { EvaluationContext } from "./evaluate.ts";
import { normaliseRemote } from "./remote.ts";

/**
 * Node kinds a predicate may not contain. `exists` reads an unknown field as absent, and a quantifier or fold over the context's roles reads unknown roles as an empty list, so each would turn "the host did not say" into a definite answer that can grant. The remaining kinds need resolvers a context does not have.
 */
const UNSUPPORTED_KINDS: ReadonlySet<string> = new Set([
  "exists",
  "some",
  "every",
  "fold",
  "accumulator",
  "lookup",
  "delegate",
  "treeReference",
  "call",
]);

/** Fields whose value is opaque JSON data rather than a child node, so a `kind` inside one is not a node. */
const DATA_FIELDS: ReadonlySet<string> = new Set([
  "key",
  "payload",
  "table",
  "collection",
]);

/** The kinds of unsupported nodes in a predicate tree, in the order they are met. */
export function unsupportedPredicateKinds(tree: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    if (
      "kind" in value &&
      typeof value.kind === "string" &&
      UNSUPPORTED_KINDS.has(value.kind)
    ) {
      found.push(value.kind);
    }
    for (const [name, child] of Object.entries(value)) {
      if (!DATA_FIELDS.has(name)) walk(child);
    }
  };
  walk(tree);
  return found;
}

const NOT_FOUND: Resolution = { found: false };

function text(value: string | undefined): Resolution {
  return value === undefined
    ? NOT_FOUND
    : { found: true, value: { kind: "text", value } };
}

/**
 * The resolvers a predicate reads the context through. A reference key names a context field: `cwd`, `branch`, `actor`, `remote` (normalised, as `when.remote` compares it), `env:NAME` (text) or `role:NAME` (a boolean, unknown when the host reported no roles). A field the context does not carry resolves to not-found.
 */
function contextResolvers(ctx: EvaluationContext): SyncResolvers {
  return {
    resolveValue: (key) => {
      if (typeof key !== "string") return NOT_FOUND;
      if (key === "cwd") return text(ctx.cwd);
      if (key === "branch") return text(ctx.branch);
      if (key === "actor") return text(ctx.actor);
      if (key === "remote") {
        return text(
          ctx.remote === undefined ? undefined : normaliseRemote(ctx.remote),
        );
      }
      if (key.startsWith("env:")) return text(ctx.env?.[key.slice(4)]);
      if (key.startsWith("role:")) {
        if (ctx.roles === undefined) return NOT_FOUND;
        return {
          found: true,
          value: { kind: "boolean", value: ctx.roles.includes(key.slice(5)) },
        };
      }
      return NOT_FOUND;
    },
    resolveLookup: () => NOT_FOUND,
    resolveCollection: () => {
      throw new Error(
        "a when.predicate cannot iterate a collection; the schema rejects some, every and fold",
      );
    },
  };
}

const evaluator = createSyncEvaluator({});

/**
 * Check a rule's `predicate` and return it as a tree.
 *
 * @throws A `ZodError` when it is not a predicate tree, or an `Error` naming the unsupported node kinds: a policy built in code does not pass through the schema, and a predicate the evaluator cannot judge soundly must not be evaluated.
 */
export function parsePredicate(predicate: unknown): PredicateNode {
  const unsupported = unsupportedPredicateKinds(predicate);
  if (unsupported.length > 0) {
    throw new Error(
      `a when.predicate cannot contain ${[...new Set(unsupported)].join(", ")} nodes`,
    );
  }
  return PredicateNodeSchema.parse(predicate);
}

/** A predicate's result under a context. */
export function evaluatePredicateCondition(
  predicate: PredicateNode,
  ctx: EvaluationContext,
): Evaluation<boolean> {
  return evaluator.evaluatePredicate(
    predicate,
    undefined,
    contextResolvers(ctx),
  );
}
