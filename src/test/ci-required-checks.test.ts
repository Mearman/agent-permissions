import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { z } from "zod";

const Job = z.looseObject({
  name: z.string().optional(),
  if: z.string().optional(),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  steps: z
    .array(
      z.looseObject({
        run: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});
type Jobs = Record<string, z.infer<typeof Job>>;
const Workflow = z.object({ jobs: z.record(z.string(), Job) });

const workflow = Workflow.parse(
  parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", ".github", "workflows", "ci.yml"),
      "utf-8",
    ),
  ),
);

/** The job a ruleset's required status check should name. */
const AGGREGATE = "required-checks";

/**
 * The only conditions that make a job run on a push and never on a pull request. Any other
 * condition on a job outside the aggregate is refused, because a condition that merely mentions the
 * push event (`push || pull_request`, a negation, a status function) can still run on a pull
 * request.
 */
const PUSH_ONLY_CONDITIONS: readonly string[] = [
  "github.event_name == 'push'",
  "github.ref == 'refs/heads/main' && github.event_name == 'push'",
];

/** The status functions that let a job run although a job it needs was skipped or failed. */
const STATUS_FUNCTION = /\b(?:always|failure|cancelled|success)\s*\(/u;

function needsOf(jobs: Jobs, id: string): string[] {
  const needs = jobs[id]?.needs;
  if (needs === undefined) return [];
  return typeof needs === "string" ? [needs] : needs;
}

/** A job's condition with its whitespace collapsed and any `${{ }}` wrapper removed. */
function normalisedCondition(jobs: Jobs, id: string): string | undefined {
  const condition = jobs[id]?.if;
  if (condition === undefined) return undefined;
  const unwrapped = /^\$\{\{(.*)\}\}$/su.exec(condition.trim());
  return (unwrapped?.[1] ?? condition).trim().replace(/\s+/gu, " ");
}

/**
 * Whether a job runs only on a push, where no pull request is waiting on it: its condition is one
 * of the exact push-only forms, or it needs a push-only job and its own condition has no status
 * function that would run it when that job is skipped.
 */
function pushOnly(
  jobs: Jobs,
  id: string,
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (seen.has(id)) return false;
  const condition = normalisedCondition(jobs, id);
  if (condition !== undefined && PUSH_ONLY_CONDITIONS.includes(condition)) {
    return true;
  }
  if (condition !== undefined && STATUS_FUNCTION.test(condition)) return false;
  return needsOf(jobs, id).some((need) =>
    pushOnly(jobs, need, new Set([...seen, id])),
  );
}

void describe("ci.yml required-checks", () => {
  const job = workflow.jobs[AGGREGATE];

  void it("has the name a ruleset's required status check should use", () => {
    assert.equal(job?.name, "Required Checks");
  });

  void it("needs every job that runs on a pull request, so none can be ignored by the merge", () => {
    const expected = Object.keys(workflow.jobs)
      .filter((id) => id !== AGGREGATE && !pushOnly(workflow.jobs, id))
      .sort();
    assert.deepEqual([...needsOf(workflow.jobs, AGGREGATE)].sort(), expected);
  });

  void it("leaves out a job only when its condition is exactly a push-only form", () => {
    const needed = needsOf(workflow.jobs, AGGREGATE);
    const outside = Object.keys(workflow.jobs).filter(
      (id) => id !== AGGREGATE && !needed.includes(id),
    );
    for (const id of outside) {
      assert.equal(
        pushOnly(workflow.jobs, id),
        true,
        `${id} is outside the aggregate`,
      );
    }
  });

  void describe("the push-only classification", () => {
    const parsed = (jobs: Record<string, unknown>): Jobs =>
      Workflow.parse({ jobs }).jobs;

    void it("accepts the exact push-only conditions", () => {
      assert.equal(
        pushOnly(parsed({ a: { if: "github.event_name == 'push'" } }), "a"),
        true,
      );
      assert.equal(
        pushOnly(
          parsed({
            a: {
              if: "${{ github.ref == 'refs/heads/main' &&   github.event_name == 'push' }}",
            },
          }),
          "a",
        ),
        true,
      );
    });

    void it("refuses a condition that can run on a pull request", () => {
      for (const condition of [
        "github.event_name == 'push' || github.event_name == 'pull_request'",
        "always() && github.event_name == 'push'",
        "!(github.event_name == 'push')",
        "github.event_name != 'pull_request'",
        "contains(github.event_name, 'push')",
      ]) {
        assert.equal(
          pushOnly(parsed({ a: { if: condition } }), "a"),
          false,
          condition,
        );
      }
    });

    void it("follows a need on a push-only job unless the condition runs despite it", () => {
      const release = { if: "github.event_name == 'push'" };
      assert.equal(
        pushOnly(parsed({ release, a: { needs: ["release"] } }), "a"),
        true,
      );
      assert.equal(
        pushOnly(
          parsed({ release, a: { needs: ["release"], if: "always()" } }),
          "a",
        ),
        false,
      );
    });
  });

  void it("runs even when a needed job fails, since a skipped aggregate reads as passing", () => {
    assert.equal(job?.if, "always()");
  });

  void describe("its verdict", () => {
    const step = job?.steps?.[0];
    const script = step?.run;
    assert.ok(script !== undefined, "the aggregate has a run step");

    function verdict(results: string): number | null {
      return spawnSync("bash", ["-c", script ?? ""], {
        env: { PATH: process.env.PATH ?? "", RESULTS: results },
      }).status;
    }

    void it("passes on success and on a job skipped on purpose", () => {
      assert.equal(verdict("success success skipped success"), 0);
    });

    void it("fails on a failed, cancelled or unrecognised result", () => {
      for (const bad of ["failure", "cancelled", "timed_out", "neutral"]) {
        assert.equal(verdict(`success ${bad}`), 1, bad);
      }
    });

    void it("reads the results from the needs context", () => {
      assert.equal(step?.env?.RESULTS, "${{ join(needs.*.result, ' ') }}");
    });
  });
});
