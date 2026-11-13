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
const Workflow = z.object({ jobs: z.record(z.string(), Job) });

const workflow = Workflow.parse(
  parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", ".github", "workflows", "ci.yml"),
      "utf-8",
    ),
  ),
);

/** The job branch protection waits on. */
const AGGREGATE = "required-checks";

function needsOf(id: string): string[] {
  const needs = workflow.jobs[id]?.needs;
  if (needs === undefined) return [];
  return typeof needs === "string" ? [needs] : needs;
}

/**
 * Whether a job runs only on a push, where no pull request is waiting on it: its own condition
 * names the push event, or it needs a job that does.
 */
function pushOnly(id: string, seen: ReadonlySet<string> = new Set()): boolean {
  if (seen.has(id)) return false;
  const condition = workflow.jobs[id]?.if ?? "";
  if (/github\.event_name\s*==\s*'push'/u.test(condition)) return true;
  return needsOf(id).some((need) => pushOnly(need, new Set([...seen, id])));
}

void describe("ci.yml required-checks", () => {
  const job = workflow.jobs[AGGREGATE];

  void it("is named as the ruleset's required status check is", () => {
    assert.equal(job?.name, "Required Checks");
  });

  void it("needs every job that runs on a pull request, so none can be ignored by the merge", () => {
    const expected = Object.keys(workflow.jobs)
      .filter((id) => id !== AGGREGATE && !pushOnly(id))
      .sort();
    assert.deepEqual([...needsOf(AGGREGATE)].sort(), expected);
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
