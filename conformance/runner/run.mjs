// Loads the conformance corpus, checks it against its format and runs its cases through a target that maps a module name to the exports under test. No policy logic lives here: a case names what to call, with what, and what it must give. The rules are in conformance/README.md.
import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const FROM = /^(?:[a-z0-9._-]+\.test\.ts: .+|recorded: .+)$/u;
const ROOT_FILES = [
  "README.md",
  "case.schema.json",
  "manifest.json",
  "manifest.schema.json",
];
const SKIPPED_DIRECTORIES = ["fixtures", "runner"];
const utf16 = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @typedef {{ id: string, from: string, kind: string, skip?: "ts" | "rust", [field: string]: unknown }} Case
 * @typedef {{ files: Record<string, { cases: number, skip: string[] }> }} Manifest
 */

/**
 * Parses a UTF-8 JSON file, refusing bytes that are not UTF-8.
 * @param {string} path
 * @returns {unknown}
 */
export function readJson(path) {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)),
  );
}

/**
 * The corpus files under a root, and the entries that are neither corpus files nor skipped. A name starting with a dot is ignored, `fixtures` and `runner` directories are skipped, and a corpus file is `<area>/<name>.json`.
 * @param {string} root
 * @returns {{ selected: string[], problems: string[] }}
 */
export function selectCorpusFiles(root) {
  const selected = [];
  const problems = [];
  const scan = (relative, depth) => {
    const entries = readdirSync(join(root, relative), {
      withFileTypes: true,
    }).sort((a, b) => utf16(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
        if (depth === 0 && NAME.test(entry.name)) scan(path, depth + 1);
        else problems.push(path);
      } else if (
        entry.isFile() &&
        depth === 0 &&
        ROOT_FILES.includes(entry.name)
      )
        continue;
      else if (
        entry.isFile() &&
        depth === 1 &&
        entry.name.endsWith(".json") &&
        NAME.test(entry.name)
      )
        selected.push(path);
      else problems.push(path);
    }
  };
  scan("", 0);
  return { selected, problems };
}

/**
 * Validates one parsed corpus file against the case schema and the rules the schema cannot express.
 * @param {import("ajv").ValidateFunction<unknown>} validate
 * @param {unknown} document
 * @returns {string[]} the problems, none when the file is valid
 */
export function fileProblems(validate, document) {
  if (!validate(document))
    return validate.errors.map(
      (error) => `${error.instancePath || "/"} ${error.message}`,
    );
  const ids = new Set();
  const problems = [];
  for (const { id, from } of document.cases) {
    if (!NAME.test(id)) problems.push(`id ${id} is not a name`);
    if (ids.has(id)) problems.push(`id ${id} is used twice`);
    ids.add(id);
    if (!FROM.test(from))
      problems.push(
        `${id}: from is neither a test title nor a recorded behaviour`,
      );
  }
  return problems;
}

/**
 * Compiles the case and manifest schemas in strict mode, so a keyword Ajv does not know is an error.
 * @param {unknown} caseSchema
 * @param {unknown} manifestSchema
 * @returns {{ validateFile: import("ajv").ValidateFunction<unknown>, validateManifest: import("ajv").ValidateFunction<unknown> }}
 */
export function compileSchemas(caseSchema, manifestSchema) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return {
    validateFile: ajv.compile(/** @type {object} */ (caseSchema)),
    validateManifest: ajv.compile(/** @type {object} */ (manifestSchema)),
  };
}

/**
 * The problems of a manifest: the schema, file names at the corpus depth, and each `skip` list in ascending order.
 * @param {import("ajv").ValidateFunction} validate
 * @param {unknown} manifest
 * @returns {string[]}
 */
export function manifestProblems(validate, manifest) {
  if (!validate(manifest))
    return (validate.errors ?? []).map(
      (error) => `${error.instancePath || "/"} ${error.message}`,
    );
  const problems = [];
  for (const [name, entry] of Object.entries(
    /** @type {Manifest} */ (manifest).files,
  )) {
    const parts = name.split("/");
    if (
      parts.length !== 2 ||
      !parts.every((part) => NAME.test(part)) ||
      !name.endsWith(".json")
    )
      problems.push(`${name} is not <area>/<name>.json`);
    if (entry.skip.some((id) => !NAME.test(id)))
      problems.push(`${name}: a skipped id is not a name`);
    if (
      JSON.stringify(entry.skip) !== JSON.stringify([...entry.skip].sort(utf16))
    )
      problems.push(`${name}: skip is not in ascending order`);
  }
  return problems;
}

/**
 * Loads a whole corpus root and checks it against its manifest: every file valid, ids unique across files, and the cases and the skipped ids of each file as the manifest records them.
 * @param {string} root
 * @param {ReturnType<typeof compileSchemas>} schemas
 * @returns {{ files: { name: string, cases: Case[] }[], manifest: Manifest, problems: string[] }}
 */
export function loadCorpus(root, schemas) {
  const { selected, problems } = selectCorpusFiles(root);
  const files = [];
  /** @type {Manifest} */
  let manifest = { files: {} };
  const owner = new Map();
  for (const name of selected) {
    let document;
    try {
      document = readJson(join(root, name));
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
      continue;
    }
    for (const problem of fileProblems(schemas.validateFile, document))
      problems.push(`${name}: ${problem}`);
    if (!Array.isArray(document.cases)) continue;
    for (const { id } of document.cases) {
      if (owner.has(id) && owner.get(id) !== name)
        problems.push(`${name}: case id ${id} is used by ${owner.get(id)}`);
      owner.set(id, name);
    }
    files.push({ name, cases: document.cases });
  }
  try {
    manifest = /** @type {Manifest} */ (readJson(join(root, "manifest.json")));
    const found = manifestProblems(schemas.validateManifest, manifest);
    for (const problem of found) problems.push(`manifest.json: ${problem}`);
    if (found.length === 0) {
      for (const name of new Set([
        ...Object.keys(manifest.files),
        ...files.map((file) => file.name),
      ])) {
        const file = files.find((candidate) => candidate.name === name);
        const entry = manifest.files[name];
        const skip = file?.cases
          .filter((c) => c.skip !== undefined)
          .map((c) => c.id)
          .sort(utf16);
        if (
          entry === undefined ||
          file === undefined ||
          file.cases.length !== entry.cases ||
          JSON.stringify(skip) !== JSON.stringify(entry.skip)
        )
          problems.push(`manifest.json does not match ${name}`);
      }
    }
  } catch (error) {
    problems.push(`manifest.json: ${error.message}`);
  }
  return { files, manifest, problems };
}

/** A value as JSON holds it: absent and undefined are the same, and anything JSON cannot hold is refused. */
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value === null || typeof value !== "object") {
    if (
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint"
    )
      throw new TypeError(`not JSON: ${typeof value}`);
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`not JSON: ${value.constructor?.name}`);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .map(([key, member]) => [key, plain(member)]),
  );
}

const walk = (value, path) =>
  path.reduce(
    (at, key) =>
      key === "length" && (Array.isArray(at) || typeof at === "string")
        ? at.length
        : at?.[key],
    value,
  );

const inOrder = (text, fragments) => {
  let from = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, from);
    assert.notEqual(
      at,
      -1,
      `${JSON.stringify(text)} lacks ${JSON.stringify(fragment)} after offset ${from}`,
    );
    from = at + fragment.length;
  }
};

/** Calls `module.function` (a dotted export path) with the case's arguments. */
async function call(target, { module, function: name, args }) {
  const exports = target.lib[module];
  assert.ok(exports !== undefined, `no module ${module}`);
  const [head, ...rest] = name.split(".");
  const holder = rest.slice(0, -1).reduce((at, key) => at[key], exports[head]);
  const method = rest.length === 0 ? exports[head] : holder[rest.at(-1)];
  assert.equal(
    typeof method,
    "function",
    `${module}.${name} is not a function`,
  );
  return await method.apply(rest.length === 0 ? undefined : holder, args);
}

/** The error a call throws, or undefined when it returns. */
const thrown = async (run) => {
  try {
    return { result: await run() };
  } catch (error) {
    return { error };
  }
};

const same = (actual, expected, unordered) =>
  assert.deepStrictEqual(
    unordered ? [...actual].sort() : actual,
    unordered ? [...expected].sort() : expected,
  );

/** Every member of `expected` is in `actual` and equal; arrays have the same length and match element by element. */
const subset = (actual, expected, at = "") => {
  if (expected !== null && typeof expected === "object") {
    assert.ok(
      actual !== null && typeof actual === "object",
      `${at}: not an object`,
    );
    if (Array.isArray(expected))
      assert.equal(actual.length, expected.length, `${at}: length`);
    for (const key of Object.keys(expected))
      subset(actual[key], expected[key], `${at}/${key}`);
  } else assert.equal(actual, expected, at);
};

/** One check of a value read from the result (or the error): `equals`, `notEquals`, `contains` or `subset`. */
const verify = (root, check, unordered) => {
  const value = plain(walk(root, check.at));
  if ("absent" in check) assert.equal(value, undefined);
  else if ("equals" in check) same(value, check.equals, unordered);
  else if ("contains" in check) inOrder(value, check.contains);
  else if ("subset" in check) subset(value, check.subset);
  else assert.notDeepStrictEqual(value, check.notEquals);
};

/**
 * @typedef {{ lib: Record<string, object>, kinds: Record<string, (testCase: Case, target: Target) => Promise<void>> }} Target
 */

/**
 * Runs one case against a target, throwing on the first difference. `target.kinds` runs the kinds that need more than a call.
 * @param {Case} testCase
 * @param {Target} target
 * @returns {Promise<void>}
 */
export async function runCase(testCase, target) {
  if (testCase.kind === "function") {
    const { result, error } = await thrown(() => call(target, testCase));
    if (testCase.throws !== undefined) {
      assert.ok(error !== undefined, "expected a throw");
      if (testCase.throws.name !== undefined)
        assert.equal(error.name, testCase.throws.name);
      inOrder(error.message, testCase.throws.message ?? []);
      for (const check of testCase.throws.checks ?? []) verify(error, check);
      return;
    }
    if (error !== undefined) throw error;
    if (testCase.expectUndefined) assert.equal(result, undefined);
    else if (testCase.expect !== undefined)
      same(plain(result), testCase.expect, testCase.unordered);
    for (const check of testCase.checks ?? [])
      verify(result, check, testCase.unordered);
  } else if (testCase.kind === "evaluate") {
    const { lib } = target;
    const { policy, tool, input, context } = testCase;
    const args = context === undefined ? [tool, input] : [tool, input, context];
    assert.equal(
      lib.evaluate.evaluate(policy, ...args),
      testCase.expect,
      "evaluate",
    );
    assert.equal(
      lib.evaluate.explain(policy, ...args).decision,
      testCase.expect,
      "explain",
    );
    assert.equal(
      lib.evaluate.compile(policy).evaluate(...args),
      testCase.expect,
      "compile",
    );
  } else if (testCase.kind === "shell-differential") {
    const missed = [];
    let splittable = 0;
    for (const { line, ran } of testCase.lines) {
      const commands = target.lib.shell.splitShellCommand(line);
      if (commands === undefined) continue;
      splittable += 1;
      const words = new Set(
        commands.map((command) =>
          command
            .split(/\s+/)
            .find(
              (word) => word !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word),
            ),
        ),
      );
      for (const marker of ran)
        if (!words.has(marker))
          missed.push(`${JSON.stringify(line)} ran ${marker}`);
    }
    assert.deepEqual(missed.slice(0, 5), [], `seed ${testCase.seed}`);
    assert.ok(
      splittable / testCase.lines.length >= testCase.minimumSplittableShare,
      `only ${splittable} lines were splittable`,
    );
  } else {
    await target.kinds[testCase.kind](testCase, target);
  }
}
