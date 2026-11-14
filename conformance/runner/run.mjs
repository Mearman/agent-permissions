// Runs one conformance case against a target that maps module names to the exports under test. No policy logic lives here (conformance/README.md).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const TOKEN = /\$DIR(\d+)/g;
const QUIET_MS = 600;
const is = (value) => value !== null && typeof value === "object";
const same = (a, b, unordered) => assert.deepStrictEqual(unordered ? [...a].sort() : a, unordered ? [...b].sort() : b);

/**
 * @typedef {{ id: string, from: string, kind: string, skip?: "ts" | "rust", [field: string]: unknown }} Case
 * @typedef {{ lib: Record<string, object>, cli?: string[] }} Target
 */

function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (!is(value)) {
    assert.ok(!["function", "symbol", "bigint"].includes(typeof value), `not JSON: ${typeof value}`);
    return value;
  }
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)), `not JSON: ${value.constructor?.name}`);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, plain(v)]),
  );
}

const mapStrings = (v, f) =>
  typeof v === "string"
    ? f(v)
    : Array.isArray(v)
      ? v.map((x) => mapStrings(x, f))
      : is(v)
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), mapStrings(x, f)]))
        : v;
const walk = (v, path) => path.reduce((at, key) => (key === "length" && (Array.isArray(at) || typeof at === "string") ? at.length : at?.[key]), v);
const bad = (code) => Object.assign(new Error(`${code}: injected`), { code });

const inOrder = (text, fragments) => {
  let from = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, from);
    assert.notEqual(at, -1, `${JSON.stringify(text)} lacks ${JSON.stringify(fragment)} after offset ${from}`);
    from = at + fragment.length;
  }
};

const subset = (actual, expected, at = "") => {
  if (!is(expected)) return assert.equal(actual, expected, at);
  assert.ok(is(actual), `${at}: not an object`);
  if (Array.isArray(expected)) assert.equal(actual.length, expected.length, `${at}: length`);
  for (const key of Object.keys(expected)) subset(actual[key], expected[key], `${at}/${key}`);
};

const verify = (root, check, unordered, back) => {
  const raw = walk(root, check.at);
  const value = "present" in check ? raw : "subset" in check ? back(raw) : back(plain(raw));
  if ("present" in check) assert.ok(raw !== undefined && raw !== null, "absent");
  else if ("absent" in check) assert.equal(value, undefined);
  else if ("equals" in check) same(value, check.equals, unordered);
  else if ("contains" in check) inOrder(value, check.contains);
  else if ("excludes" in check) for (const text of check.excludes) assert.ok(!value.includes(text), `holds ${text}`);
  else if ("subset" in check) subset(value, check.subset);
  else assert.notDeepStrictEqual(value, check.notEquals);
};

const matches = (a, e) =>
  e === "$any"
    ? true
    : is(e) && e.$contains
      ? typeof a === "string" && (inOrder(a, e.$contains), true)
      : is(e) && e.$subset
        ? is(a) && Object.keys(e.$subset).every((k) => matches(a[k], e.$subset[k]))
        : is(e)
          ? is(a) && Object.keys(e).length === Object.keys(a).length && Object.keys(e).every((k) => matches(a[k], e[k]))
          : a === e;

function directories(testCase) {
  const dirs = [];
  for (const [, n] of JSON.stringify(testCase).matchAll(TOKEN)) dirs[n] ??= realpathSync(mkdtempSync(join(tmpdir(), "conformance-")));
  const place = (text) => text.replace(TOKEN, (_, n) => dirs[n]);
  const put = (name, text) => {
    mkdirSync(name.endsWith("/") ? place(name) : dirname(place(name)), { recursive: true });
    if (name.endsWith("/")) return;
    if (text === null) rmSync(place(name), { force: true });
    else writeFileSync(place(name), text.$bytes === undefined ? place(text) : Buffer.from(text.$bytes, "base64"));
  };
  for (const [name, text] of Object.entries(testCase.files ?? {})) put(name, text);
  const back = (v) => mapStrings(v, (t) => dirs.reduce((at, path, n) => at.split(path).join(`$DIR${n}`), t));
  const files = (expected) =>
    Object.fromEntries(
      Object.keys(expected ?? {}).map((n) => [
        n,
        n.endsWith("/") ? readdirSync(place(n)).sort().join("\n") : existsSync(place(n)) ? back(readFileSync(place(n), "utf8")) : null,
      ]),
    );
  return { dirs, place, put, back, files, done: () => dirs.forEach((p) => rmSync(p, { recursive: true, force: true })) };
}

function decoder(refs) {
  const decode = (v) => {
    if (Array.isArray(v)) return v.map(decode);
    if (!is(v)) return v;
    const [key] = Object.keys(v);
    const one = Object.keys(v).filter((k) => k !== "as").length === 1;
    if (!one || !key.startsWith("$")) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
    const x = v[key];
    const value = {
      $undefined: () => undefined,
      $number: () => Number(x),
      $bytes: () => Buffer.from(x, "base64"),
      $signal: () => new AbortController().signal,
      $ref: () => refs[x],
      $map: () => new Map(x.map(([k, val]) => [decode(k), decode(val)])),
      $returns: () => () => Promise.resolve(decode(x)),
      $reject: () => () => Promise.reject(bad(x)),
      $edit: () => async () => writeFileSync(x.path, x.text),
      $readError: () => async (path) => (x[path] ? Promise.reject(bad(x[path])) : readFile(path)),
    }[key]();
    if (v.as !== undefined) refs[v.as] = value;
    return value;
  };
  return decode;
}

async function call({ lib }, { module, function: name, args }, argv) {
  const [head, ...rest] = name.split(".");
  const holder = rest.slice(0, -1).reduce((at, key) => at[key], lib[module][head]);
  const method = rest.length === 0 ? lib[module][head] : holder[rest.at(-1)];
  if (args === undefined) return { result: method };
  assert.equal(typeof method, "function", `${module}.${name} is not a function`);
  try {
    return { result: await method.apply(rest.length === 0 ? undefined : holder, argv) };
  } catch (error) {
    return { error };
  }
}

async function step(target, s, tree, decode) {
  if (s.files) for (const [name, text] of Object.entries(s.files)) tree.put(name, text);
  const written = [];
  const real = process.stderr.write;
  process.stderr.write = (chunk) => (written.push(String(chunk)), true);
  const run = await call(target, s, decode(mapStrings(s.args ?? [], tree.place))).finally(() => (process.stderr.write = real));
  const { result, error } = run;
  const text = tree.back(written.join(""));
  if (s.throws !== undefined) {
    assert.ok(error !== undefined, "expected a throw");
    if (s.throws.name !== undefined) assert.equal(error.name, s.throws.name);
    inOrder(tree.back(error.message), s.throws.message ?? []);
    for (const check of s.throws.checks ?? []) verify(error, check, false, tree.back);
  } else {
    if (error !== undefined) throw error;
    if (s.expectUndefined) assert.equal(result, undefined);
    else if (s.expect !== undefined) same(tree.back(plain(result)), s.expect, s.unordered);
    for (const check of s.checks ?? []) verify(result, check, s.unordered, tree.back);
  }
  inOrder(text, s.stderr?.includes ?? []);
  for (const absent of s.stderr?.absent ?? []) assert.ok(!text.includes(absent), `stderr holds ${absent}`);
}

function decide(lib, policy, c, back) {
  const args = c.context === undefined ? [c.tool, c.input] : [c.tool, c.input, c.context];
  const { evaluate, explain, compile } = lib.evaluate;
  const explained = explain(policy, ...args);
  assert.equal(evaluate(policy, ...args), c.expect, "evaluate");
  assert.equal(explained.decision, c.expect, "explain");
  assert.equal(compile(policy).evaluate(...args), c.expect, "compile");
  if (c.layer !== undefined) assert.equal(back(explained.steps[0].layer), c.layer, "layer");
  for (const e of c.steps ? [explained, compile(policy).explain(...args)] : [])
    same(
      e.steps.map((s) => [s.command, s.decision]),
      c.steps,
    );
}

function process_(command, argv, options) {
  const child = spawn(command, argv, options);
  let out = "";
  let err = "";
  let ended = false;
  const waiters = [];
  const poke = () => waiters.splice(0).forEach((w) => w());
  child.stdout.on("data", (d) => ((out += d), poke()));
  child.stderr.on("data", (d) => ((err += d), poke()));
  child.on("close", () => ((ended = true), poke()));
  const until = (ready, what) =>
    new Promise((resolve, reject) => {
      const check = () => (ready() ? resolve() : ended ? reject(new Error(`ended before ${what}`)) : waiters.push(check));
      check();
    });
  return { child, until, out: () => out, err: () => err, ended: () => ended };
}

const lineAt = (text, n) => text.split("\n").slice(0, -1)[n];

async function mcp(tc, tree, target) {
  const [command, ...flags] = target.cli;
  const p = process_(command, [...flags, "mcp", ...tc.args.map(tree.place)], {
    cwd: tree.dirs[0],
    env: { ...process.env, ...mapStrings(tc.env ?? {}, tree.place) },
  });
  let seen = 0;
  try {
    for (const s of tc.exchange) {
      if (s.send !== undefined) p.child.stdin.write(`${JSON.stringify(s.send)}\n`);
      else if (s.expect !== undefined) {
        await p.until(() => lineAt(p.out(), seen) !== undefined, `line ${seen}`);
        const actual = JSON.parse(lineAt(p.out(), seen++));
        assert.ok(matches(tree.back(actual), s.expect), `line ${seen - 1}: ${JSON.stringify(actual)}`);
      } else if (s.waitStderr !== undefined) await p.until(() => p.err().includes(s.waitStderr), s.waitStderr);
      else tree.put(s.writeFile.path, s.writeFile.text);
    }
  } finally {
    p.child.stdin.end();
    p.child.kill();
    await p.until(() => p.ended(), "exit").catch(() => undefined);
  }
  inOrder(tree.back(p.err()), tc.stderrIncludes ?? []);
}

async function watch(tc, tree, { lib }) {
  const reports = [];
  const watcher = lib.loader.watchPolicy(
    { cwd: tree.place(tc.cwd) },
    (policy) => reports.push({ policy }),
    (error) => reports.push({ error }),
  );
  let closed = false;
  try {
    for (const s of tc.steps) {
      reports.length = 0;
      if (s.close) (watcher.close(), (closed = true));
      for (const [name, text] of Object.entries(s.files ?? {})) tree.put(name, text);
      const want = s.reports ?? [];
      for (let waited = 0; reports.length < want.length && !closed && waited < 400; waited++) await new Promise((r) => setTimeout(r, 25));
      if (want.length === 0) await new Promise((r) => setTimeout(r, QUIET_MS));
      assert.equal(reports.length, want.length, `reports: ${reports.map((r) => Object.keys(r)[0])}`);
      want.forEach((w, i) => {
        if (w.error) inOrder(reports[i].error.message, w.error.message ?? []);
        else
          for (const [tool, input, expect] of w.decisions)
            assert.equal(lib.evaluate.evaluate(reports[i].policy, tool, input), expect, `${tool} ${input}`);
      });
    }
  } finally {
    watcher.close();
  }
}

/**
 * Runs one case against a target, throwing on the first difference.
 * @param {Case} testCase @param {Target} target @returns {Promise<void>}
 */
export async function runCase(testCase, target) {
  const tree = directories(testCase);
  const { lib } = target;
  try {
    const kind = testCase.kind;
    if (kind === "function" || kind === "steps") {
      const decode = decoder({});
      for (const s of testCase.steps ?? [testCase]) {
        await step(target, s, tree, decode);
        if (s !== testCase && s.expectFiles) same(tree.files(s.expectFiles), s.expectFiles);
      }
    } else if (kind === "evaluate") decide(lib, testCase.policy, testCase, tree.back);
    else if (kind === "layered") {
      const load = testCase.load && { ...testCase.load, cwd: tree.place(testCase.load.cwd) };
      const policy = testCase.layers ? lib.loader.mergeLayerPolicies(testCase.layers) : await lib.loader.loadPolicy(load);
      if (testCase.expectPolicy) subset(policy, testCase.expectPolicy);
      for (const c of testCase.calls) decide(lib, policy, c, tree.back);
    } else if (kind === "prompt") {
      const asked = [];
      const onAsk = async (ask) => (asked.push(`${ask.request.tool_name} ${ask.subject} ${ask.explanation.decision}`), testCase.approval);
      const options = {
        loadPolicy: async () => testCase.policy,
        root: testCase.root,
        context: testCase.context,
        ...(testCase.approval && { onAsk }),
      };
      const result = await lib["prompt-tool"].createPermissionPrompt(options)(testCase.request, new AbortController().signal);
      const { messageIncludes, ...rest } = testCase.expect;
      if (result.behavior === "allow") same(result, rest);
      else subset(result, rest);
      inOrder(result.message ?? "", messageIncludes ?? []);
      same(asked, testCase.asked ?? []);
    } else if (kind === "cli") {
      const [command, ...flags] = target.cli;
      const cwd = testCase.cwd === undefined ? undefined : tree.place(testCase.cwd);
      const run = spawnSync(command, [...flags, ...testCase.args.map(tree.place)], {
        cwd,
        input: testCase.stdin ?? "",
        encoding: "utf8",
        env: { ...process.env, ...mapStrings(testCase.env ?? {}, tree.place) },
      });
      const { exit, stdout, stdoutJson, stderrIncludes, stderrExcludes } = testCase.expect;
      assert.equal(run.status, exit, run.stderr);
      if (stdout !== undefined) assert.equal(tree.back(run.stdout), stdout);
      if (stdoutJson !== undefined) same(plain(tree.back(JSON.parse(run.stdout))), stdoutJson);
      inOrder(tree.back(run.stderr), stderrIncludes ?? []);
      for (const text of stderrExcludes ?? []) assert.ok(!tree.back(run.stderr).includes(text), `stderr holds ${text}`);
    } else if (kind === "mcp") await mcp(testCase, tree, target);
    else if (kind === "watch") await watch(testCase, tree, target);
    else if (kind === "shell-differential") {
      const missed = [];
      let splittable = 0;
      for (const { line, ran } of testCase.lines) {
        const commands = lib.shell.splitShellCommand(line);
        if (commands === undefined) continue;
        splittable += 1;
        const words = new Set(commands.map((c) => c.split(/\s+/).find((w) => w !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))));
        for (const marker of ran) if (!words.has(marker)) missed.push(`${JSON.stringify(line)} ran ${marker}`);
      }
      assert.deepEqual(missed.slice(0, 5), [], `seed ${testCase.seed}`);
      assert.ok(splittable / testCase.lines.length >= testCase.minimumSplittableShare, `only ${splittable} lines were splittable`);
    }
    if (testCase.expectFiles !== undefined) same(tree.files(testCase.expectFiles), testCase.expectFiles);
  } finally {
    tree.done();
  }
}
