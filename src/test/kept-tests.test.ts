/**
 * The tests that stay in TypeScript are listed in `conformance/README.md` with the reason each cannot be a corpus case, and the list is checked in both directions: a test with no row fails, and a row with no test fails.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { testTitles } from "./test-titles.ts";

const README = join(
  import.meta.dirname,
  "..",
  "..",
  "conformance",
  "README.md",
);

/** The tests that run the corpus and check this list: they are the corpus's own harness, not tests kept from it. */
const HARNESS = ["conformance.test.ts", "kept-tests.test.ts"];

/** The cells of one table row, with `\|` read as a `|` inside a cell. */
function cells(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));
}

/** The rows of the table under the heading, as `file`, `test` and `reason`. */
function keptRows(): { file: string; title: string; reason: string }[] {
  const text = readFileSync(README, "utf-8");
  const section = text.split(/^## Tests kept in TypeScript$/mu)[1];
  assert.ok(
    section !== undefined,
    "the README has a section for the kept tests",
  );
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map(cells);
  return rows.map(([file, title, reason, ...rest]) => {
    assert.equal(
      rest.length,
      0,
      `a row with more than three cells: ${String(file)}`,
    );
    assert.ok(
      file !== undefined && title !== undefined && reason !== undefined,
      "a row with three cells",
    );
    return { file: file.replaceAll("`", ""), title, reason };
  });
}

void describe("the tests kept in TypeScript", () => {
  const tests = testTitles(import.meta.dirname, HARNESS);
  const rows = keptRows();
  const key = (file: string, title: string): string => `${file}: ${title}`;

  void it("has a row for every test in the test files", () => {
    const listed = new Set(rows.map((row) => key(row.file, row.title)));
    const missing = tests
      .map((t) => key(t.file, t.title))
      .filter((k) => !listed.has(k));
    assert.deepEqual(missing, []);
  });

  void it("has a test for every row", () => {
    const present = new Set(tests.map((t) => key(t.file, t.title)));
    const stale = rows
      .map((row) => key(row.file, row.title))
      .filter((k) => !present.has(k));
    assert.deepEqual(stale, []);
  });

  void it("lists no test twice and gives every row a reason", () => {
    const keys = rows.map((row) => key(row.file, row.title));
    assert.deepEqual(
      keys.filter((k, i) => keys.indexOf(k) !== i),
      [],
    );
    assert.deepEqual(
      rows.filter((row) => row.reason === ""),
      [],
    );
  });
});
