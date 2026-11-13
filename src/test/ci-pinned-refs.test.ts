import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const GITHUB_DIR = join(import.meta.dirname, "..", "..", ".github");

/** Every workflow and composite action file, with its text. */
function ciFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const workflows = join(GITHUB_DIR, "workflows");
  for (const name of readdirSync(workflows)) {
    files.push({
      path: `workflows/${name}`,
      text: readFileSync(join(workflows, name), "utf-8"),
    });
  }
  const actions = join(GITHUB_DIR, "actions");
  for (const name of readdirSync(actions)) {
    files.push({
      path: `actions/${name}/action.yml`,
      text: readFileSync(join(actions, name, "action.yml"), "utf-8"),
    });
  }
  return files;
}

const FULL_SHA = /^[0-9a-f]{40}$/u;

/** The `uses:` references to something outside this repository, and where they are. */
function externalUses(text: string): string[] {
  return [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gmu)]
    .map((m) => m[1])
    .filter((ref): ref is string => ref !== undefined && !ref.startsWith("./"));
}

/** The first path segment after the repository in each `raw.githubusercontent.com` URL, which is the ref. */
function rawRefs(text: string): string[] {
  return [
    ...text.matchAll(
      /raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/([\w.-]+)\//gu,
    ),
  ].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

void describe("CI references are immutable", () => {
  void it("pins every action to a full commit SHA", () => {
    for (const { path, text } of ciFiles()) {
      for (const ref of externalUses(text)) {
        assert.match(ref.split("@")[1] ?? "", FULL_SHA, `${path}: ${ref}`);
      }
    }
  });

  void it("downloads from a raw GitHub URL only at a full commit SHA", () => {
    for (const { path, text } of ciFiles()) {
      for (const ref of rawRefs(text)) {
        assert.match(ref, FULL_SHA, `${path}: ${ref}`);
      }
    }
  });

  void it("finds the unpinned forms it is meant to refuse", () => {
    assert.deepEqual(externalUses("      - uses: actions/checkout@v7"), [
      "actions/checkout@v7",
    ]);
    assert.deepEqual(externalUses("      - uses: ./.github/actions/setup"), []);
    assert.deepEqual(
      rawRefs("curl https://raw.githubusercontent.com/o/r/main/s.sh"),
      ["main"],
    );
    assert.deepEqual(
      rawRefs(
        "curl https://raw.githubusercontent.com/o/r/refs/heads/main/s.sh",
      ),
      ["refs"],
    );
  });
});
