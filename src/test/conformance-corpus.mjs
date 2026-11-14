// Loads the conformance corpus and checks it against its format: the part of the TypeScript harness that is not the shared runner.
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
const utf16 = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const messages = (validate) =>
  (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);

/**
 * @typedef {{ id: string, from: string, kind: string, skip?: "ts" | "rust", [field: string]: unknown }} Case
 * @typedef {{ files: Record<string, { cases: number, skip: string[] }> }} Manifest
 * @typedef {{ lib: Record<string, object>, cli?: string[] }} Target
 */

/** @param {string} path @returns {unknown} */
export function readJson(path) {
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)),
  );
}

/** @param {string} root @returns {{ selected: string[], problems: string[] }} */
export function selectCorpusFiles(root) {
  const selected = [];
  const problems = [];
  const scan = (relative, depth) => {
    for (const entry of readdirSync(join(root, relative), {
      withFileTypes: true,
    }).sort((a, b) => utf16(a.name, b.name))) {
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

/** @param {import("ajv").ValidateFunction<unknown>} validate @param {unknown} document @returns {string[]} */
export function fileProblems(validate, document) {
  if (!validate(document)) return messages(validate);
  const ids = new Set();
  return document.cases.flatMap(({ id, from }) => {
    const found = [
      !NAME.test(id) && `id ${id} is not a name`,
      ids.has(id) && `id ${id} is used twice`,
      !FROM.test(from) && `${id}: bad from`,
    ];
    ids.add(id);
    return found.filter(Boolean);
  });
}

/** @param {unknown} caseSchema @param {unknown} manifestSchema @returns {{ validateFile: import("ajv").ValidateFunction<unknown>, validateManifest: import("ajv").ValidateFunction<unknown> }} */
export function compileSchemas(caseSchema, manifestSchema) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return {
    validateFile: ajv.compile(/** @type {object} */ (caseSchema)),
    validateManifest: ajv.compile(/** @type {object} */ (manifestSchema)),
  };
}

/** @param {import("ajv").ValidateFunction<unknown>} validate @param {unknown} manifest @returns {string[]} */
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
 * Loads a corpus root and checks it against its manifest.
 * @param {string} root @param {ReturnType<typeof compileSchemas>} schemas
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
