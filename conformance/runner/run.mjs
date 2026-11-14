// Loads the conformance corpus, checks it against its format and runs its cases through a target that maps a module name to the exports under test. A case names what to call, with what, and what it must give; no policy logic lives here (conformance/README.md).
import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const FROM = /^(?:[a-z0-9._-]+\.test\.ts: .+|recorded: .+)$/u;
const ROOT_FILES = [
  "README.md",
  "case.schema.json",
  "manifest.json",
  "manifest.schema.json",
];
const TOKEN = /\$DIR(\d+)/g;
const utf16 = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const messages = (validate) =>
  (validate.errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message}`,
  );

/**
 * @typedef {{ id: string, from: string, kind: string, skip?: "ts" | "rust", [field: string]: unknown }} Case
 * @typedef {{ files: Record<string, { cases: number, skip: string[] }> }} Manifest
 * @typedef {{ lib: Record<string, object>, cli?: string[] }} Target
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
 * The corpus files under a root (`<area>/<name>.json`, dot names ignored, `fixtures` and `runner` skipped) and the entries that are neither.
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
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (
        entry.name.startsWith(".") ||
        ["fixtures", "runner"].includes(entry.name)
      )
        continue;
      if (entry.isDirectory() && depth === 0 && NAME.test(entry.name))
        scan(path, 1);
      else if (entry.isFile() && depth === 0 && ROOT_FILES.includes(entry.name))
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
 * The problems of a parsed corpus file: the case schema, then the rules the schema cannot express.
 * @param {import("ajv").ValidateFunction<unknown>} validate
 * @param {unknown} document
 * @returns {string[]}
 */
export function fileProblems(validate, document) {
  if (!validate(document)) return messages(validate);
  const ids = new Set();
  return document.cases.flatMap(({ id, from }) => {
    const found = [
      !NAME.test(id) && `id ${id} is not a name`,
      ids.has(id) && `id ${id} is used twice`,
      !FROM.test(from) &&
        `${id}: from is neither a test title nor a recorded behaviour`,
    ];
    ids.add(id);
    return found.filter(Boolean);
  });
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
 * @param {import("ajv").ValidateFunction<unknown>} validate
 * @param {unknown} manifest
 * @returns {string[]}
 */
export function manifestProblems(validate, manifest) {
  if (!validate(manifest)) return messages(validate);
  return Object.entries(/** @type {Manifest} */ (manifest).files).flatMap(
    ([name, { skip }]) => [
      ...(name.split("/").length === 2 &&
      name.split("/").every((part) => NAME.test(part)) &&
      name.endsWith(".json")
        ? []
        : [`${name} is not <area>/<name>.json`]),
      ...(skip.every((id) => NAME.test(id))
        ? []
        : [`${name}: a skipped id is not a name`]),
      ...(JSON.stringify(skip) === JSON.stringify([...skip].sort(utf16))
        ? []
        : [`${name}: skip is not in ascending order`]),
    ],
  );
}

/**
 * Loads a corpus root and checks it against its manifest: every file valid, ids unique across files, and each file's case count and skipped ids as recorded.
 * @param {string} root
 * @param {ReturnType<typeof compileSchemas>} schemas
 * @returns {{ files: { name: string, cases: Case[] }[], manifest: Manifest, problems: string[] }}
 */
export function loadCorpus(root, schemas) {
  const { selected, problems } = selectCorpusFiles(root);
  const files = [];
  const owner = new Map();
  /** @type {Manifest} */
  let manifest = { files: {} };
  for (const name of selected) {
    try {
      const document = readJson(join(root, name));
      for (const problem of fileProblems(schemas.validateFile, document))
        problems.push(`${name}: ${problem}`);
      if (!Array.isArray(document.cases)) continue;
      for (const { id } of document.cases) {
        if (owner.has(id) && owner.get(id) !== name)
          problems.push(`${name}: case id ${id} is used by ${owner.get(id)}`);
        owner.set(id, name);
      }
      files.push({ name, cases: document.cases });
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  try {
    manifest = /** @type {Manifest} */ (readJson(join(root, "manifest.json")));
    const found = manifestProblems(schemas.validateManifest, manifest);
    problems.push(...found.map((problem) => `manifest.json: ${problem}`));
    for (const name of found.length > 0
      ? []
      : new Set([
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
  } catch (error) {
    problems.push(`manifest.json: ${error.message}`);
  }
  return { files, manifest, problems };
}

/** A value as JSON holds it: absent and undefined are the same, and anything JSON cannot hold is refused. */
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value === null || typeof value !== "object") {
    assert.ok(
      !["function", "symbol", "bigint"].includes(typeof value),
      `not JSON: ${typeof value}`,
    );
    return value;
  }
  assert.ok(
    [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    `not JSON: ${value.constructor?.name}`,
  );
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .map(([key, member]) => [key, plain(member)]),
  );
}

const mapStrings = (value, f) =>
  typeof value === "string"
    ? f(value)
    : Array.isArray(value)
      ? value.map((item) => mapStrings(item, f))
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, member]) => [
              key,
              mapStrings(member, f),
            ]),
          )
        : value;
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

/** Every member of `expected` is in `actual` and equal; lists have the same length and match element by element. */
const subset = (actual, expected, at = "") => {
  if (expected === null || typeof expected !== "object")
    return assert.equal(actual, expected, at);
  assert.ok(
    actual !== null && typeof actual === "object",
    `${at}: not an object`,
  );
  if (Array.isArray(expected))
    assert.equal(actual.length, expected.length, `${at}: length`);
  for (const key of Object.keys(expected))
    subset(actual[key], expected[key], `${at}/${key}`);
};

const same = (actual, expected, unordered) =>
  assert.deepStrictEqual(
    unordered ? [...actual].sort() : actual,
    unordered ? [...expected].sort() : expected,
  );

/** One check of a value read from a result (or an error): `equals`, `notEquals`, `contains`, `subset` or `absent`. */
const verify = (root, check, unordered, back) => {
  const value = back(plain(walk(root, check.at)));
  if ("absent" in check) assert.equal(value, undefined);
  else if ("equals" in check) same(value, check.equals, unordered);
  else if ("contains" in check) inOrder(value, check.contains);
  else if ("subset" in check) subset(value, check.subset);
  else assert.notDeepStrictEqual(value, check.notEquals);
};

/**
 * The directories a case names with `$DIRn` tokens, made fresh and holding the case's `files`. `place` turns a token into a path, `back` a path into its token, `files` reads the case's `expectFiles` out of the directories, and `done` removes them.
 * @param {Case} testCase
 */
function directories(testCase) {
  const dirs = [];
  for (const [, n] of JSON.stringify(testCase).matchAll(TOKEN))
    dirs[n] ??= realpathSync(mkdtempSync(join(tmpdir(), "conformance-")));
  const place = (text) => text.replace(TOKEN, (_, n) => dirs[n]);
  for (const [name, text] of Object.entries(testCase.files ?? {})) {
    mkdirSync(dirname(place(name)), { recursive: true });
    writeFileSync(place(name), place(text));
  }
  const back = (value) =>
    mapStrings(value, (text) =>
      dirs.reduce((at, path, n) => at.split(path).join(`$DIR${n}`), text),
    );
  return {
    dirs,
    place,
    back,
    files: () =>
      Object.fromEntries(
        Object.keys(testCase.expectFiles ?? {}).map((name) => [
          name,
          existsSync(place(name))
            ? back(readFileSync(place(name), "utf8"))
            : null,
        ]),
      ),
    done: () =>
      dirs.forEach((path) => rmSync(path, { recursive: true, force: true })),
  };
}

/** Calls `module.function` (a dotted path into the module's exports), awaiting a promise; returns the result or the error it threw. */
async function call({ lib }, { module, function: name }, args) {
  const [head, ...rest] = name.split(".");
  const holder = rest
    .slice(0, -1)
    .reduce((at, key) => at[key], lib[module][head]);
  const method = rest.length === 0 ? lib[module][head] : holder[rest.at(-1)];
  assert.equal(
    typeof method,
    "function",
    `${module}.${name} is not a function`,
  );
  try {
    return {
      result: await method.apply(rest.length === 0 ? undefined : holder, args),
    };
  } catch (error) {
    return { error };
  }
}

/**
 * Runs one case against a target, throwing on the first difference. `target.cli` is the command that starts the CLI, for `cli` cases.
 * @param {Case} testCase
 * @param {Target} target
 * @returns {Promise<void>}
 */
export async function runCase(testCase, target) {
  const tree = directories(testCase);
  try {
    if (testCase.kind === "function") {
      const { result, error } = await call(
        target,
        testCase,
        mapStrings(testCase.args, tree.place),
      );
      if (testCase.throws !== undefined) {
        assert.ok(error !== undefined, "expected a throw");
        if (testCase.throws.name !== undefined)
          assert.equal(error.name, testCase.throws.name);
        inOrder(error.message, testCase.throws.message ?? []);
        for (const check of testCase.throws.checks ?? [])
          verify(error, check, false, tree.back);
      } else {
        if (error !== undefined) throw error;
        if (testCase.expectUndefined) assert.equal(result, undefined);
        else if (testCase.expect !== undefined)
          same(tree.back(plain(result)), testCase.expect, testCase.unordered);
        for (const check of testCase.checks ?? [])
          verify(result, check, testCase.unordered, tree.back);
      }
    } else if (testCase.kind === "evaluate") {
      const { policy, tool, input, context } = testCase;
      const args =
        context === undefined ? [tool, input] : [tool, input, context];
      const { evaluate, explain, compile } = target.lib.evaluate;
      assert.equal(evaluate(policy, ...args), testCase.expect, "evaluate");
      assert.equal(
        explain(policy, ...args).decision,
        testCase.expect,
        "explain",
      );
      assert.equal(
        compile(policy).evaluate(...args),
        testCase.expect,
        "compile",
      );
    } else if (testCase.kind === "cli") {
      const [command, ...flags] = target.cli;
      const run = spawnSync(
        command,
        [...flags, ...testCase.args.map(tree.place)],
        {
          cwd:
            testCase.cwd === undefined ? undefined : tree.place(testCase.cwd),
          input: testCase.stdin ?? "",
          encoding: "utf8",
          env: {
            ...process.env,
            ...mapStrings(testCase.env ?? {}, tree.place),
          },
        },
      );
      const { exit, stdout, stdoutJson, stderrIncludes } = testCase.expect;
      assert.equal(run.status, exit, run.stderr);
      if (stdout !== undefined) assert.equal(tree.back(run.stdout), stdout);
      if (stdoutJson !== undefined)
        assert.deepStrictEqual(
          plain(tree.back(JSON.parse(run.stdout))),
          stdoutJson,
        );
      inOrder(tree.back(run.stderr), stderrIncludes ?? []);
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
    }
    if (testCase.expectFiles !== undefined)
      assert.deepStrictEqual(tree.files(), testCase.expectFiles);
  } finally {
    tree.done();
  }
}
