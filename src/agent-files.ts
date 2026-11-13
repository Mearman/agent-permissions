/**
 * Agent config file resolution — shared between CLI and sync.
 *
 * Maps format names to default file paths, walks directories to find configs, and provides
 * read/write helpers for the convert/validate/check/sync pipeline.
 */

import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  findNodeAtLocation,
  modify,
  parse as parseJsonc,
  parseTree,
  type ParseError,
} from "jsonc-parser";
import { ZodError } from "zod";
import {
  Document,
  isMap,
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
} from "yaml";
import { basename, dirname, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { MODELLED_PATHS, OmpEncoded, type AgentId } from "./compat/codecs.ts";
import { isAgentId, isRecord } from "./guards.ts";
import { SyncRefusedError } from "./sync-error.ts";
import { type Format } from "./api.ts";

// ---------------------------------------------------------------------------
// File mapping
// ---------------------------------------------------------------------------

/** A path of object keys from the top level of a JSON document. */
export type JsonPath = readonly string[];

/** Per-format config file info. */
export interface AgentFileDef {
  /** Relative path to the main config file. */
  name: string;
  /** Relative path to the local override file (read-only, never written). */
  localName?: string;
  /**
   * Extract the permissions payload from a parsed native config. Returns undefined if the config
   * doesn't contain a permissions block.
   */
  extract?: (raw: unknown) => unknown;
  /** Wrap encoded permissions back into the native config structure. */
  wrap?: (encoded: unknown) => unknown;
  /**
   * Other names the file is read under, preferred to `name` when one exists (OpenCode's JSONC
   * form). A file is created under `name` only when none of them exists.
   */
  alternateNames?: readonly string[];
  /** Whether the agent reads the file as JSONC, so comments and trailing commas are valid. */
  jsonc?: boolean;
  /** The top-level key `extract` reads, named when its content cannot be decoded. */
  payloadKey?: string;
  /**
   * The leaf paths of the native file that the codec both reads and writes. Sync replaces exactly
   * these paths (removing one the encoding has no value for) and leaves every other byte of the
   * file alone; decode sees only these paths, so a setting the codec does not model neither fails
   * the decode nor is lost. Absent for a file that is wholly the tool's own.
   */
  modelled?: readonly JsonPath[];
}

/** Default config file for each agent format, relative to a project root. */
export const AGENT_FILES: Record<AgentId | "canonical", AgentFileDef> = {
  canonical: {
    name: ".agents/permissions.json",
    localName: ".agents/permissions.local.json",
    extract: (raw) => raw,
    wrap: (encoded) => encoded,
  },
  "claude-code": {
    name: ".claude/settings.json",
    localName: ".claude/settings.local.json",
    extract: (raw) => {
      if (!isRecord(raw) || !("permissions" in raw)) return undefined;
      return raw.permissions;
    },
    wrap: (encoded) => ({ permissions: encoded }),
    payloadKey: "permissions",
    modelled: MODELLED_PATHS["claude-code"].map((path) => [
      "permissions",
      ...path,
    ]),
  },
  codex: { name: "codex.toml" }, // TOML — read only if pre-parsed
  opencode: {
    name: "opencode.json",
    alternateNames: ["opencode.jsonc"],
    jsonc: true,
    extract: (raw) => {
      if (!isRecord(raw) || !("permission" in raw)) return undefined;
      return raw.permission;
    },
    wrap: (encoded) => ({ permission: encoded }),
    payloadKey: "permission",
    modelled: MODELLED_PATHS.opencode.map((path) => ["permission", ...path]),
  },
  crush: { name: ".crush.json" }, // Crush has no standard config file
  // OMP's project config. Its global copy lives in the agent directory (see ompGlobalConfigPath),
  // and sync writes either one only through editOmpConfig, so `wrap` is not used.
  omp: {
    name: ".omp/config.yml",
    extract: (raw) => (isRecord(raw) ? raw : undefined),
  },
  kiro: {
    name: ".kiro/permissions.json",
    extract: (raw) => raw,
    wrap: (encoded) => encoded,
    modelled: MODELLED_PATHS.kiro,
  },
};

/** Every name a format's main file is read under, preferred first. */
export function nativeFileNames(def: AgentFileDef): string[] {
  return [...(def.alternateNames ?? []), def.name];
}

/**
 * A format's main file in a directory: the first of its names that exists there, else the name a
 * new file gets.
 */
export function nativeConfigPath(dir: string, def: AgentFileDef): string {
  return (
    nativeFileNames(def)
      .map((name) => join(dir, name))
      .find((candidate) => existsSync(candidate)) ?? join(dir, def.name)
  );
}

/**
 * The agent whose JSON config file a path is, by the trailing segments of its name, for the agents
 * whose file holds other settings beside the permissions. Anything else is an arbitrary output
 * file.
 */
export function nativeFormatOfPath(path: string): AgentId | undefined {
  const normalised = path.split(sep).join("/");
  for (const [format, def] of Object.entries(AGENT_FILES)) {
    if (def.modelled === undefined || !isAgentId(format)) continue;
    if (nativeFileNames(def).some((n) => normalised.endsWith(`/${n}`))) {
      return format;
    }
  }
  return undefined;
}

/**
 * The agent whose own config file a path is when that file has no permissions-only edit (Codex's
 * TOML, Crush's file), so an existing one cannot be written without losing its other settings.
 */
export function opaqueFormatOfPath(
  path: string,
): "codex" | "crush" | undefined {
  const normalised = path.split(sep).join("/");
  for (const format of ["codex", "crush"] as const) {
    if (normalised.endsWith(`/${AGENT_FILES[format].name}`)) return format;
  }
  return undefined;
}

/** Get the default file name for a format. */
export function defaultFileName(format: Format): string {
  return AGENT_FILES[format].name;
}

// ---------------------------------------------------------------------------
// Walk-up resolution
// ---------------------------------------------------------------------------

/**
 * Walk up from a starting directory, looking for a format's default file. Returns the first
 * existing file found, or the default path in `startDir`.
 */
export function findDefaultFile(format: Format, startDir: string): string {
  const def = AGENT_FILES[format];
  let dir = resolve(startDir);
  for (;;) {
    const candidate = nativeConfigPath(dir, def);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(resolve(startDir), def.name);
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Discriminated union for operations that can fail. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Create a successful result. */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** Create a failed result. */
export function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Read / write helpers
// ---------------------------------------------------------------------------

/** Read stdin as a string. */
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    // The stream's iterator types its chunks as `any`; instanceof narrows without an assertion. Buffer is a Uint8Array subclass, so binary chunks take the first branch.
    if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    } else if (typeof chunk === "string") {
      chunks.push(new TextEncoder().encode(chunk));
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Read from a file path, or stdin if undefined. */
export async function readInput(path: string | undefined): Promise<string> {
  if (path === undefined) return readStdin();
  return readFile(path, "utf-8");
}

/** Parse a JSON string. Returns a Result instead of throwing. */
export function parseJson(raw: string, source: string): Result<unknown> {
  try {
    return ok(JSON.parse(raw));
  } catch {
    return fail(`${source}: invalid JSON`);
  }
}

/**
 * Parse an agent's native config. OMP's is YAML; every other agent's is JSON. YAML is a superset of
 * JSON, so an OMP config written as JSON parses too.
 */
export function parseAgentFile(
  format: Format | undefined,
  raw: string,
  source: string,
): Result<unknown> {
  if (format !== "omp" && !/\.ya?ml$/u.test(source)) {
    const jsonc =
      (format !== undefined && AGENT_FILES[format].jsonc === true) ||
      source.endsWith(".jsonc");
    return jsonc ? parseNativeJson(raw, source, true) : parseJson(raw, source);
  }
  try {
    const value: unknown = parseYaml(raw);
    return ok(value);
  } catch {
    return fail(`${source}: invalid YAML`);
  }
}

const BYTE_ORDER_MARK = "\uFEFF";

/**
 * Whether a config file's text is empty, or only whitespace and a byte order mark. Such a file
 * holds no settings: as a source it contributes nothing, and as a target it is written as a new
 * document.
 */
export function isBlank(text: string): boolean {
  return text.replace(BYTE_ORDER_MARK, "").trim() === "";
}

/**
 * Parse a native agent config as the agent reads it: JSONC when `jsonc`, otherwise strict JSON,
 * which refuses comments and trailing commas with a message that says so. A leading byte order
 * mark is skipped.
 */
export function parseNativeJson(
  raw: string,
  source: string,
  jsonc: boolean,
): Result<unknown> {
  const text = raw.startsWith(BYTE_ORDER_MARK)
    ? raw.slice(BYTE_ORDER_MARK.length)
    : raw;
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, {
    allowTrailingComma: jsonc,
    disallowComments: !jsonc,
  });
  if (errors.length === 0) return ok(value);
  if (!jsonc) {
    const lenient: ParseError[] = [];
    parseJsonc(text, lenient, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    if (lenient.length === 0) {
      return fail(
        `${source}: comments and trailing commas are not valid here, because the agent reads this file as strict JSON`,
      );
    }
  }
  return fail(`${source}: invalid JSON`);
}

/** A native config as file content: YAML for OMP, JSON for everything else. */
export function stringifyAgentFile(
  format: Format,
  value: unknown,
  compact: boolean,
): string {
  if (format === "omp") return stringifyYaml(value);
  return JSON.stringify(value, null, compact ? undefined : 2) + "\n";
}

/**
 * OMP's agent directory, which holds its global config: `PI_CODING_AGENT_DIR` when set, as OMP
 * reads it, else `~/.omp/agent`.
 */
export function ompAgentDir(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  return env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent");
}

/** OMP's agent directory for this process. */
export function defaultOmpAgentDir(): string {
  return ompAgentDir(process.env, homedir());
}

/**
 * OMP's global config in an agent directory, chosen as OMP chooses it: the first of `config.yml`
 * and `config.yaml` that exists, else `config.yml`.
 */
export function ompGlobalConfigPath(agentDir: string): string {
  const yaml = join(agentDir, "config.yaml");
  const yml = join(agentDir, "config.yml");
  return !existsSync(yml) && existsSync(yaml) ? yaml : yml;
}

/**
 * An OMP config with `bash.patterns` and `tools.approvalMode` set from an encoded policy and
 * everything else, comments included, left as it was. `bash.patterns` is replaced by the encoded
 * list, or removed when there is none; `tools.approvalMode` is set only when the encoding has one,
 * so a mode the policy leaves to OMP stays as the user wrote it.
 *
 * @param current The file's content, or `null` for a new file.
 * @throws Error when `current` is not valid YAML or its top level is not a mapping, rather than
 *   replacing a file it could not read.
 */
export function editOmpConfig(
  current: string | null,
  encoded: OmpEncoded,
): string {
  const doc = current === null ? new Document({}) : parseDocument(current);
  const [error] = doc.errors;
  if (error !== undefined) {
    throw new Error(`invalid YAML: ${error.message}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error("an OMP config must be a mapping at the top level");
  }
  if (encoded.bash === undefined) {
    if (doc.hasIn(["bash", "patterns"])) doc.deleteIn(["bash", "patterns"]);
  } else {
    doc.setIn(["bash", "patterns"], doc.createNode(encoded.bash.patterns));
  }
  if (encoded.tools !== undefined) {
    doc.setIn(["tools", "approvalMode"], encoded.tools.approvalMode);
  }
  return doc.toString();
}

/** What a walk down a path found: the value, or the first prefix holding something that is not an object. */
interface Lookup {
  value: unknown;
  /** Set when a prefix of the path holds a non-object, so nothing can lie beneath it. */
  blocked?: { depth: number; value: unknown };
}

function lookup(root: unknown, path: JsonPath): Lookup {
  let current: unknown = root;
  for (const [depth, key] of path.entries()) {
    if (!isRecord(current)) {
      return { value: undefined, blocked: { depth, value: current } };
    }
    if (!Object.hasOwn(current, key)) return { value: undefined };
    current = current[key];
  }
  return { value: current };
}

function setAt(
  target: Record<string, unknown>,
  path: JsonPath,
  value: unknown,
): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = Object.hasOwn(node, key) ? node[key] : undefined;
    if (next === undefined) {
      const child: Record<string, unknown> = {};
      node[key] = child;
      node = child;
    } else if (isRecord(next)) {
      node = next;
    } else {
      return;
    }
  }
  const last = path.at(-1);
  if (last !== undefined) node[last] = value;
}

/**
 * A copy of a parsed native config holding only the modelled paths. Where a prefix of a path holds
 * something that is not an object (OpenCode's `"permission": "allow"`), that value is kept whole.
 */
export function pickModelled(
  raw: unknown,
  paths: readonly JsonPath[],
): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const picked: Record<string, unknown> = {};
  for (const path of paths) {
    const found = lookup(raw, path);
    if (found.blocked !== undefined) {
      setAt(picked, path.slice(0, found.blocked.depth), found.blocked.value);
      continue;
    }
    // A container the file holds stays present even when none of its modelled leaves is set, so an
    // empty `permissions` object is still a permissions payload.
    const container = path.slice(0, -1);
    if (
      container.length > 0 &&
      lookup(picked, container).value === undefined &&
      isRecord(lookup(raw, container).value)
    ) {
      setAt(picked, container, {});
    }
    if (found.value !== undefined) setAt(picked, path, found.value);
  }
  return picked;
}

/**
 * Refuse to edit a path when the file holds it, or one of its parents, more than once. The agent
 * reads the last occurrence, as `JSON.parse` does, while the text edit finds the first, so the edit
 * would change a value the agent ignores and leave the one it reads.
 */
function refuseDuplicates(text: string, path: JsonPath, source: string): void {
  let node = parseTree(text);
  for (const key of path) {
    if (node?.type !== "object") return;
    const matching = (node.children ?? []).filter(
      (property) => property.children?.[0]?.value === key,
    );
    if (matching.length > 1) {
      throw new SyncRefusedError(
        source,
        "duplicate-key",
        `holds the key "${key}" more than once, so the value the agent reads cannot be edited safely; remove the duplicate`,
      );
    }
    node = matching[0]?.children?.[1];
  }
}

/** How the text of a file is laid out, so inserted text matches it. */
interface Layout {
  /** One level of indentation. */
  unit: string;
  eol: string;
  /** Whether the file spans more than one line; a one-line file gets compact insertions. */
  multiline: boolean;
}

function layoutOf(text: string): Layout {
  const indent = /^([ \t]+)\S/mu.exec(text)?.[1];
  return {
    unit: indent === undefined ? "  " : indent.startsWith("\t") ? "\t" : indent,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    multiline: text.includes("\n"),
  };
}

/** The leading whitespace of the line holding an offset. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/u.exec(text.slice(start))?.[0] ?? "";
}

/** A value as JSON in a file's layout, its continuation lines indented from `base`. */
function printValue(value: unknown, layout: Layout, base: string): string {
  if (!layout.multiline) return JSON.stringify(value);
  return JSON.stringify(value, null, layout.unit)
    .split("\n")
    .join(`\n${base}`)
    .replace(/\n/gu, layout.eol);
}

/** One splice of the file's text. */
interface Splice {
  offset: number;
  length: number;
  content: string;
}

function splice(text: string, edit: Splice): string {
  return (
    text.slice(0, edit.offset) +
    edit.content +
    text.slice(edit.offset + edit.length)
  );
}

/**
 * The splice that sets `path` in a parsed document to `value`: a replacement of the old value's
 * text, an insertion after the object's last property, or, for `undefined`, the removal jsonc-parser
 * works out (it takes the comma with it). Everything outside the spliced span stays as it was.
 */
function setPath(
  text: string,
  path: JsonPath,
  value: unknown,
  layout: Layout,
): Splice[] {
  if (value === undefined) {
    return modify(text, [...path], undefined, {}).map((edit) => ({
      offset: edit.offset,
      length: edit.length,
      content: edit.content,
    }));
  }
  const root = parseTree(text);
  const existing = root ? findNodeAtLocation(root, [...path]) : undefined;
  if (existing !== undefined) {
    return [
      {
        offset: existing.offset,
        length: existing.length,
        content: printValue(value, layout, lineIndent(text, existing.offset)),
      },
    ];
  }
  const key = path.at(-1);
  const parent = root
    ? findNodeAtLocation(root, [...path.slice(0, -1)])
    : undefined;
  if (key === undefined || parent?.type !== "object") {
    throw new Error("the document has no object to insert into");
  }
  const properties = parent.children ?? [];
  const last = properties.at(-1);
  const keyText = JSON.stringify(key);
  if (last === undefined) {
    const outer = lineIndent(text, parent.offset);
    const inner = outer + layout.unit;
    return [
      {
        offset: parent.offset + 1,
        length: 0,
        content: layout.multiline
          ? `${layout.eol}${inner}${keyText}: ${printValue(value, layout, inner)}${layout.eol}${outer}`
          : `${keyText}:${printValue(value, layout, "")}`,
      },
    ];
  }
  const block = text.slice(parent.offset, last.offset).includes("\n");
  const indent = lineIndent(text, last.offset);
  const spaced = /^"(?:[^"\\]|\\.)*"\s*:\s/u.test(text.slice(last.offset));
  return [
    {
      offset: last.offset + last.length,
      length: 0,
      content: block
        ? `,${layout.eol}${indent}${keyText}: ${printValue(value, layout, indent)}`
        : `,${spaced ? " " : ""}${keyText}:${spaced ? " " : ""}${printValue(value, { ...layout, multiline: false }, "")}`,
    },
  ];
}

/**
 * A native JSON config with each modelled path replaced by the encoding's value (removed when the
 * encoding has none) and every other byte of the file untouched: the edit is a splice of the text,
 * so comments, formatting, key order, number spelling and a byte order mark survive. Where the file
 * holds a non-object in place of a parent of a modelled path, that whole value is replaced, and a
 * path whose parents are missing is created beneath the shallowest missing one in a single splice.
 *
 * @param current The file's content, or `null` for a new file.
 * @param wrapped The encoded permissions in the native structure (`AgentFileDef.wrap`).
 * @param modelled The paths `wrapped` supplies (`AgentFileDef.modelled`).
 * @param jsonc Whether the agent accepts comments and trailing commas in this file.
 * @param source The file's path, named in errors.
 * @throws Error when `current` is not valid for the agent or its top level is not an object, rather
 *   than replacing a file it could not read.
 */
export function editJsonConfig(
  current: string | null,
  wrapped: unknown,
  modelled: readonly JsonPath[],
  jsonc: boolean,
  source: string,
): string {
  if (current === null || isBlank(current)) {
    return JSON.stringify(wrapped, null, 2) + "\n";
  }
  const bom = current.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : "";
  let text = current.slice(bom.length);
  const layout = layoutOf(text);
  for (const path of modelled) {
    const parsed = parseNativeJson(text, source, jsonc);
    if (!parsed.ok) {
      throw new SyncRefusedError(
        source,
        "invalid-format",
        parsed.error.replace(`${source}: `, ""),
      );
    }
    if (!isRecord(parsed.value)) {
      throw new SyncRefusedError(
        source,
        "not-an-object",
        "the top level must be a JSON object",
      );
    }
    const found = lookup(parsed.value, path);
    // The value to replace: the non-object blocking the path, else the path itself, or, when the
    // path is absent, the shallowest missing ancestor, so a whole subtree is created at once.
    let target = path;
    if (found.blocked !== undefined) {
      target = path.slice(0, found.blocked.depth);
    } else if (found.value === undefined) {
      const missing = path.findIndex(
        (_key, depth) =>
          lookup(parsed.value, path.slice(0, depth + 1)).value === undefined,
      );
      target = path.slice(0, missing + 1);
    }
    const previous = lookup(parsed.value, target).value;
    const next = lookup(wrapped, target).value;
    if (isDeepStrictEqual(previous, next)) continue;
    refuseDuplicates(text, target, source);
    for (const edit of setPath(text, target, next, layout)) {
      text = splice(text, edit);
    }
  }
  return bom + text;
}

/**
 * A native config's content after writing `encoded` into it, for every format sync and convert
 * write: Oh My Pi's YAML is edited in place, a JSON config has its modelled paths replaced, and a
 * file that is wholly the tool's own is written whole.
 *
 * @param current The file's content, or `null` for a new file.
 * @throws Error when `current` cannot be read as the agent's format.
 */
export function renderNativeConfig(
  format: Format,
  current: string | null,
  encoded: unknown,
  source: string,
): string {
  if (format === "omp") {
    return editOmpConfig(
      current === null || isBlank(current) ? null : current,
      OmpEncoded.parse(encoded),
    );
  }
  const def = AGENT_FILES[format];
  const wrapped = def.wrap ? def.wrap(encoded) : encoded;
  if (def.modelled === undefined)
    return JSON.stringify(wrapped, null, 2) + "\n";
  return editJsonConfig(
    current,
    wrapped,
    def.modelled,
    def.jsonc === true,
    source,
  );
}

/** Whether an error carries a Node error code. */
function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

/** The message of any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why a file system call failed, without the paths Node puts in its message, so a failure on a
 * temporary file is reported against the file that was asked for.
 */
function fsReason(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const syscall =
      "syscall" in error && typeof error.syscall === "string"
        ? ` during ${error.syscall}`
        : "";
    return `${error.code}${syscall}`;
  }
  return messageOf(error);
}

/**
 * A file's text, or `null` when it does not exist. Only a missing file counts as absent: any other
 * failure (a permission error, a directory, an I/O error) is thrown naming the file, so a file that
 * exists and cannot be read is never taken for a new one and written over. The file is read as
 * bytes and decoded strictly as UTF-8, with a byte order mark kept, so what is returned writes back
 * as exactly the bytes that were read; a file that is not valid UTF-8 is refused rather than
 * rewritten with replacement characters.
 */
export async function readIfPresent(path: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw new SyncRefusedError(
      path,
      "unreadable",
      `cannot be read (${messageOf(error)})`,
      { cause: error },
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    throw new SyncRefusedError(
      path,
      "not-utf8",
      "is not valid UTF-8, so it was not read and is left as it is",
      { cause: error },
    );
  }
}

/**
 * The file a write to `path` lands on: the target of a symlink, so the link itself is kept.
 *
 * @throws Error when `path` is a symlink to a file that does not exist, since replacing it would
 *   swap the link for a regular file.
 */
async function writeTarget(path: string): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return path;
    throw error;
  }
  if (!info.isSymbolicLink()) return path;
  try {
    return await realpath(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      throw new SyncRefusedError(
        path,
        "dangling-link",
        "is a symbolic link to a file that does not exist, so it was not written",
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Stop unless the file still holds what a proposal was computed from.
 *
 * @param expected The content the proposal was computed from, or `null` for a file that was absent.
 * @throws Error when the file now differs, or cannot be read.
 */
export async function assertUnchanged(
  path: string,
  expected: string | null,
): Promise<void> {
  if ((await readIfPresent(await writeTarget(path))) !== expected) {
    throw new SyncRefusedError(
      path,
      "changed",
      "changed since it was read, so it was not written; run the command again",
    );
  }
}

/** Options of `writeFileAtomic`. */
export interface WriteFileOptions {
  /** The mode of the new file; the replaced file's mode when omitted. */
  mode?: number;
  /** The rename that puts the temporary file in place; `fs.rename` unless a test replaces it. */
  renameFile?: (from: string, to: string) => Promise<void>;
  /** Runs once the temporary file is written, before the final check; for tests of that check. */
  afterTemporaryWritten?: () => Promise<void>;
}

/**
 * Write a file through a temporary file in the same directory and a rename, so a crash or a full
 * disk never leaves it half written, after checking that it still holds what the new content was
 * computed from, and again immediately before the rename. A symlink is followed and kept. The
 * temporary file is created with the final mode, never a wider one, and has the replaced file's
 * owner, and it is removed on any failure.
 *
 * A rename cannot replace a hard-linked file without breaking the link, or a single-file bind mount
 * (it fails with `EBUSY` or `EXDEV`). For those the content is written in place instead, which keeps
 * the link and the mount and is not atomic; this is a stated condition, not a fallback for errors.
 *
 * @param expected The content the new content was computed from, or `null` for a new file; omit
 *   the check with `undefined`.
 * @throws Error when the file changed since `expected` was read, is a link to nothing, belongs to
 *   another user whose ownership cannot be kept, or cannot be written.
 */
export async function writeFileAtomic(
  path: string,
  content: string,
  expected: string | null | undefined,
  options: WriteFileOptions = {},
): Promise<void> {
  try {
    await replaceFile(path, content, expected, options);
  } catch (error) {
    // Every failure names the file asked for, never the temporary file or the link's target.
    if (error instanceof SyncRefusedError) throw error;
    throw new Error(`${path}: could not be written (${fsReason(error)})`, {
      cause: error,
    });
  }
}

async function replaceFile(
  path: string,
  content: string,
  expected: string | null | undefined,
  options: WriteFileOptions,
): Promise<void> {
  const target = await writeTarget(path);
  if (expected !== undefined) await assertUnchanged(path, expected);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  let existing;
  try {
    existing = await stat(target);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const mode = options.mode ?? (existing ? existing.mode & 0o7777 : undefined);
  const writeInPlace = async (): Promise<void> => {
    if (expected !== undefined) await assertUnchanged(path, expected);
    await writeFile(target, content);
  };
  if (existing !== undefined && existing.nlink > 1) {
    await writeInPlace();
    return;
  }
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: mode ?? 0o666 });
    if (mode !== undefined) await chmod(temporary, mode);
    const uid = process.getuid?.();
    if (existing !== undefined && uid !== undefined && existing.uid !== uid) {
      try {
        await chown(temporary, existing.uid, existing.gid);
      } catch (error) {
        throw new SyncRefusedError(
          path,
          "owner",
          `is owned by another user and sync cannot keep that owner (${messageOf(error)}), so it was not written`,
          { cause: error },
        );
      }
    }
    await options.afterTemporaryWritten?.();
    if (expected !== undefined) await assertUnchanged(path, expected);
    await (options.renameFile ?? rename)(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    if (hasCode(error, "EBUSY") || hasCode(error, "EXDEV")) {
      await writeInPlace();
      return;
    }
    throw error;
  }
}

/**
 * Keep a copy of a file's original content beside it as `<path>.bak`, with the file's mode so a
 * private config does not become readable by others, written atomically.
 *
 * @param original The file's content as it was read.
 */
export async function writeBackup(
  path: string,
  original: string,
): Promise<void> {
  const mode = (await stat(await writeTarget(path))).mode & 0o7777;
  await writeFileAtomic(`${path}.bak`, original, undefined, { mode });
}

/**
 * Write an encoded policy into an agent's native config at `path`, merging into what is there: the
 * one writer `convert` and `confine` share with `sync`.
 *
 * @throws Error when the existing file cannot be read as the agent's format, or changed meanwhile.
 */
export async function writeNativeConfig(
  format: Format,
  path: string,
  encoded: unknown,
): Promise<void> {
  const current = await readIfPresent(path);
  const content = renderNativeConfig(format, current, encoded, path);
  if (content !== current) await writeFileAtomic(path, content, current);
}

/** Write JSON to a file, creating parent directories as needed. */
export async function writeJsonFile(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// ---------------------------------------------------------------------------
// Decode / validate helpers
// ---------------------------------------------------------------------------

import { AgentPermissionPolicy } from "./schema.ts";
import { CODECS } from "./compat/codecs.ts";

/** Validation error for a single field. */
export interface ValidationError {
  /** Dot-separated path to the invalid field, or "(root)". */
  path: string;
  /** Human-readable error message. */
  message: string;
}

/** Detailed validation result with structured errors. */
export type ValidateResult =
  | { ok: true; value: AgentPermissionPolicy }
  | { ok: false; error: string; errors: ValidationError[] };

/** Validate parsed JSON against the canonical policy schema. */
export function validatePolicy(json: unknown): ValidateResult {
  const result = AgentPermissionPolicy.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const errors: ValidationError[] = result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
  return {
    ok: false,
    error: `validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join(", ")}`,
    errors,
  };
}

/**
 * The permissions payload of a parsed native config, read from its modelled paths only: a setting
 * the codec does not model is not seen. Undefined when the config has none.
 */
export function nativePayload(format: AgentId, raw: unknown): unknown {
  const def = AGENT_FILES[format];
  const subject =
    def.modelled === undefined ? raw : pickModelled(raw, def.modelled);
  return def.extract?.(subject);
}

/**
 * Decode native agent config → canonical policy. Extracts the permissions payload using the agent's
 * extract(), decodes via codec, then validates against the canonical schema.
 */
export function decodeNative(format: AgentId, raw: unknown): ValidateResult {
  const def = AGENT_FILES[format];
  if (def.extract === undefined) {
    return {
      ok: false,
      error: `${format}: no extract defined for this format`,
      errors: [],
    };
  }

  const payload = nativePayload(format, raw);
  if (payload === undefined || payload === null) {
    return {
      ok: false,
      error: `${format}: no permissions payload found in config`,
      errors: [],
    };
  }

  const codec = CODECS[format];
  let decoded: unknown;
  try {
    // The payload genuinely is unknown here (an extract() output), while each zod codec's decode is typed for its own native input — a payload of the wrong shape throws inside decode and lands in the catch below.
    // @ts-expect-error unknown payload passed to a native-typed decode; invalid shapes throw and are handled by the catch
    decoded = codec.decode(payload);
  } catch (e) {
    const prefix = def.payloadKey === undefined ? "" : `${def.payloadKey}.`;
    const message =
      e instanceof ZodError
        ? e.issues
            .map(
              (issue) => `${prefix}${issue.path.join(".")}: ${issue.message}`,
            )
            .join("; ")
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      ok: false,
      error: `${format} decode failed: ${message}`,
      errors: [],
    };
  }

  return validatePolicy(decoded);
}
