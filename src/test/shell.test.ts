/** Splitting a shell command line into the commands it runs. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitShellCommand } from "../shell.ts";

/** The order of the returned commands is not part of the contract. */
function commands(line: string): string[] | undefined {
  return splitShellCommand(line)?.sort();
}

void describe("splitShellCommand: commands it can split", () => {
  const cases: [string, string[]][] = [
    ["", []],
    ["git status", ["git status"]],
    ["  git status  ", ["git status"]],
    ["ls;", ["ls"]],
    ["git status && git diff", ["git diff", "git status"]],
    ["a; b || c | d & e\nf", ["a", "b", "c", "d", "e", "f"]],
    ["a |& b", ["a", "b"]],
    ['git commit -m "a && b"', ['git commit -m "a && b"']],
    ["echo 'a; b'", ["echo 'a; b'"]],
    [String.raw`echo a\;b`, [String.raw`echo a\;b`]],
    ["git log 2>&1 | head", ["git log 2>&1", "head"]],
    ["cmd &> out.txt", ["cmd &> out.txt"]],
    ["cmd >& out.txt", ["cmd >& out.txt"]],
    ["cmd >| out.txt", ["cmd >| out.txt"]],
    ["cat <<< word", ["cat <<< word"]],
    ["echo ${HOME}", ["echo ${HOME}"]],
    ["echo $'a\\nb'", ["echo $'a\\nb'"]],
    ["echo '$(rm -rf /)'", ["echo '$(rm -rf /)'"]],
    ["echo $(date)", ["date", "echo $(date)"]],
    ['echo "$(date) x"', ['echo "$(date) x"', "date"]],
    ["echo `date`", ["date", "echo `date`"]],
    ["echo $(echo $(id))", ["echo $(echo $(id))", "echo $(id)", "id"]],
    [
      "diff <(sort a) <(sort b)",
      ["diff <(sort a) <(sort b)", "sort a", "sort b"],
    ],
    ["echo $(a && b)", ["a", "b", "echo $(a && b)"]],
  ];
  for (const [line, expected] of cases) {
    void it(JSON.stringify(line), () => {
      assert.deepEqual(commands(line), [...expected].sort());
    });
  }
});

void describe("splitShellCommand: commands it will not split", () => {
  const unsplittable = [
    'echo "unterminated',
    "echo 'unterminated",
    "echo $(unterminated",
    "echo `unterminated",
    "echo $((1 + 2))",
    "cat <<EOF",
    "(cd x && ls)",
    "if true; then ls; fi",
    "for i in 1 2; do echo $i; done",
    "while true; do ls; done",
    "case x in a) ls;; esac",
    "ls # a comment",
    "ls \\",
    "echo ${x:-$(id)}",
    "echo ${x",
    "[[ -f x ]] && ls",
    "{ ls; }",
    "time ls",
    "! ls",
    "function f",
  ];
  for (const line of unsplittable) {
    void it(JSON.stringify(line), () => {
      assert.equal(splitShellCommand(line), undefined);
    });
  }
});
