/**
 * Runs the language-neutral conformance corpus (`conformance/`) against the TypeScript source. The runner in `conformance/runner/` is shared by every implementation; this file only supplies the modules under test.
 */

import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  compileSchemas,
  fileProblems,
  loadCorpus,
  manifestProblems,
  readJson,
  selectCorpusFiles,
} from "./conformance-corpus.mjs";
import { runCase } from "../../conformance/runner/run.mjs";
import * as agentFiles from "../agent-files.ts";
import * as api from "../api.ts";
import * as codecs from "../compat/codecs.ts";
import * as confine from "../confine.ts";
import * as evaluate from "../evaluate.ts";
import * as loader from "../loader.ts";
import * as profiles from "../profiles.ts";
import * as promptTool from "../prompt-tool.ts";
import * as remote from "../remote.ts";
import * as replay from "../replay.ts";
import * as schema from "../schema.ts";
import * as shell from "../shell.ts";
import * as sync from "../sync.ts";

/** Which implementation this runner is: a case marked `skip: "ts"` is not executed here. */
const IMPLEMENTATION = "ts";

/** The most bytes the shared runner may hold in total, so it stays a call table and never grows product logic. */
const RUNNER_BYTE_CAP = 16_384;

const ROOT = join(import.meta.dirname, "..", "..", "conformance");

const target = {
  lib: {
    "agent-files": agentFiles,
    api,
    "compat/codecs": codecs,
    confine,
    evaluate,
    loader,
    profiles,
    "prompt-tool": promptTool,
    remote,
    replay,
    schema,
    shell,
    sync,
  },
  cli: [
    process.execPath,
    "--experimental-strip-types",
    join(import.meta.dirname, "..", "cli.ts"),
  ],
};

const schemas = compileSchemas(
  readJson(join(ROOT, "case.schema.json")),
  readJson(join(ROOT, "manifest.schema.json")),
);
const corpus = loadCorpus(ROOT, schemas);
const FIXTURES = join(ROOT, "fixtures");

/** The problems a fixture has; a file that cannot be read as UTF-8 JSON counts as having one. */
function problemsOf(
  path: string,
  check: (document: unknown) => string[],
): string[] {
  try {
    return check(readJson(path));
  } catch (error) {
    return [String(error)];
  }
}

/** Every invalid fixture has a problem and its repaired twin of the same name has none. */
function fixturePairs(
  directory: string,
  check: (document: unknown) => string[],
): void {
  const names = readdirSync(join(FIXTURES, directory, "invalid")).sort();
  assert.ok(names.length > 0, `${directory} holds no fixtures`);
  assert.deepEqual(
    readdirSync(join(FIXTURES, directory, "repaired")).sort(),
    names,
  );
  for (const name of names) {
    assert.notDeepEqual(
      problemsOf(join(FIXTURES, directory, "invalid", name), check),
      [],
      `${directory}/invalid/${name} validated, and must not`,
    );
    assert.deepEqual(
      problemsOf(join(FIXTURES, directory, "repaired", name), check),
      [],
      `${directory}/repaired/${name}`,
    );
  }
}

void describe("conformance corpus", () => {
  void it("runs as an ordinary user, since the permission-based fault cases cannot fail for root", () => {
    assert.notEqual(
      process.getuid?.(),
      0,
      "the conformance corpus must not run as root: a file mode cannot refuse a read to root, so its fault cases would pass or fail for the wrong reason; run as an ordinary user",
    );
  });

  void it("is valid and equals its manifest", () => {
    assert.deepEqual(corpus.problems, []);
  });

  void it("is run in full: executed plus skipped is the manifest's total", () => {
    const total = Object.values(corpus.manifest.files).reduce(
      (sum, file) => sum + file.cases,
      0,
    );
    const registered = corpus.files.flatMap((file) => file.cases);
    const skipped = registered.filter(
      (testCase) => testCase.skip === IMPLEMENTATION,
    );
    assert.equal(registered.length, total);
    const skippedByManifest = Object.values(corpus.manifest.files).flatMap(
      (file) => file.skip,
    );
    for (const testCase of skipped) {
      assert.ok(
        skippedByManifest.includes(testCase.id),
        `${testCase.id} is skipped here and the manifest does not mark it`,
      );
    }
  });

  void it("selects the fixture tree as its expected file says", () => {
    const directory = join(FIXTURES, "loader-selection");
    assert.deepEqual(
      selectCorpusFiles(join(directory, "tree")),
      readJson(join(directory, "expected.json")),
    );
  });

  void it("refuses every invalid case file and accepts its repaired twin", () => {
    fixturePairs("cases", (document) =>
      fileProblems(schemas.validateFile, document),
    );
  });

  void it("refuses every invalid manifest and accepts its repaired twin", () => {
    fixturePairs("manifests", (document) =>
      manifestProblems(schemas.validateManifest, document),
    );
  });

  void it("refuses every invalid corpus and accepts its repaired twin", () => {
    const names = readdirSync(join(FIXTURES, "corpora", "invalid")).sort();
    assert.ok(names.length > 0);
    assert.deepEqual(
      readdirSync(join(FIXTURES, "corpora", "repaired")).sort(),
      names,
    );
    for (const name of names) {
      assert.notDeepEqual(
        loadCorpus(join(FIXTURES, "corpora", "invalid", name), schemas)
          .problems,
        [],
        name,
      );
      assert.deepEqual(
        loadCorpus(join(FIXTURES, "corpora", "repaired", name), schemas)
          .problems,
        [],
        name,
      );
    }
  });

  void it("keeps the shared runner under its byte cap", () => {
    const directory = join(ROOT, "runner");
    const bytes = readdirSync(directory).reduce(
      (sum, name) => sum + statSync(join(directory, name)).size,
      0,
    );
    assert.ok(bytes <= RUNNER_BYTE_CAP, `${String(bytes)} bytes`);
  });

  for (const file of corpus.files) {
    void describe(file.name, () => {
      for (const testCase of file.cases) {
        if (testCase.skip === IMPLEMENTATION) continue;
        void it(`${testCase.id}: ${testCase.from}`, async () => {
          await runCase(testCase, target);
        });
      }
    });
  }
});
