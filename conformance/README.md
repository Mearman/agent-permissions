# Conformance corpus

Language-neutral cases that pin the behaviour of `agent-perms`. Every implementation of the package (the TypeScript source, the native Rust crates and the wasm builds) runs the same cases, so a port is correct when it passes what the original passes.

## Layout

```text
conformance/
  README.md                  this file
  case.schema.json           JSON Schema of a corpus file
  manifest.json              what the corpus holds
  manifest.schema.json       JSON Schema of the manifest
  <area>/<name>.json         corpus files
  fixtures/                  data the runners test themselves with
  runner/                    the shared runner, in JavaScript
```

The files are UTF-8 (a loader refuses a file that is not, rather than reading replacement characters) and formatted by prettier, which the repository's lint requires.

### Which files are corpus files

Every loader applies this one rule, and each runs it over `fixtures/loader-selection` (a tree, the files it must select and the entries it must refuse) so the loaders cannot disagree:

- A name that starts with a dot is ignored, at any depth.
- A directory called `fixtures` or `runner` is skipped, at any depth, directly under the root included. It holds data cases refer to or the runner itself, never cases.
- A name is lower-case ASCII letters, digits, dots, hyphens and underscores, and starts with a letter or digit, so every loader orders names the same way. The root's own files are the exception. A name that is not is a failure.
- A corpus file is a `.json` file at `<area>/<name>.json`. The area names what the cases exercise, and a file takes its name from the test file it was extracted from (`evaluate/evaluate-hidden.json` from `evaluate-hidden.test.ts`).
- The root holds only `README.md`, `case.schema.json`, `manifest.json` and `manifest.schema.json` as files.
- Files and problems are listed in UTF-16 code unit order, directory by directory.
- Anything else, a stray file, a file of another type, a file or directory at another depth, is a failure in every loader, never ignored by one.

### The manifest

`manifest.json` records, for every corpus file, its case count and the ids of the cases an implementation skips, in ascending order. Every runner checks the corpus against it and fails on any difference. A runner also asserts that every case it skips is marked in the manifest and that what it executes plus what it skips is the manifest's total. A case marked for the other implementation is one it executes. The TypeScript runner registers one test per case when it collects the corpus, so the count holds whatever the test runner does with them (a name filter, a bail, a retry, a shuffled order).

## Cases

Every case has:

- `id`: unique across the whole corpus, in lower-case ASCII letters, digits, dots, hyphens and underscores.
- `from`: either `<test file>.test.ts: <describe> > <test>`, the original test title the case came from, so a failure points back to the behaviour it pinned, or `recorded: <what>` for a recorded case. The schema and every loader refuse a `from` in neither form. Several cases may come from one test, one for each call the test made and asserted on.
- `kind`: selects the shape below.
- `skip`, optional, with a `reason` that says why: `ts` for a case the TypeScript implementation skips, `rust` for a case the Rust implementation skips. The axis is the implementation, never the host: a wasm build of the Rust engine is `rust` wherever it runs (native, Node, a browser or Workers). A case one implementation cannot run carries it; nothing else does. A `reason` without `skip` is refused.
- `notes`, optional: where a case says something its fields do not, such as that the original asserted facts derived from a result and the case records the whole result.

A case comes from an existing test, with the same inputs and the same expectation, and an expectation is never weaker than the original's. Where the original asserted a derived fact (a count, an `includes`, a field), the case records the whole value it was derived from, and `notes` says so. Messages are compared only where the original test asserted one: a `reason` text that no test pinned is not in a case. A recorded case is one written for the corpus because no test covered the behaviour; its `from` starts `recorded:` and says what it records.

### Values

A case holds JSON, so a value JSON cannot hold is written the way JSON holds it: a member whose value is `undefined` is absent, and a result that is `undefined` is `expectUndefined`. Arguments may carry encodings for what JSON cannot: `{"$undefined": true}`, `{"$number": "-0"}` (also `Infinity`, `-Infinity`, `NaN`), `{"$bytes": "<base64>"}`, `{"$signal": true}` (an abort signal), `{"$map": [[key, value]]}` (a `Map`, which `"as": "<name>"` names and `{"$ref": "<name>"}` reuses in a later step of the same case), and the functions `{"$returns": value}` (resolves to the value), `{"$reject": "EIO"}` (rejects with that error code), `{"$edit": {"path", "text"}}` (writes a file when called, the concurrent edit of a fault case) and `{"$readError": {"<path>": "EIO"}}` (reads a file, failing for those paths). Fault-injection cases are never skipped: a runner produces them through the seam of the call, or through a real tree for what a file system can make by itself. A runner compares a result after dropping its `undefined` members, and refuses a result JSON cannot hold (a function, a `Map`, a class instance) rather than comparing it loosely. A `files` path ending in `/` is an empty directory, and an `expectFiles` path ending in `/` stands for the sorted names in that directory, one per line, so a case can say that no temporary file is left behind. Object key order is never part of an expectation; array order is, except where a case says `unordered`.

### Kinds

`function`: calls an export.

```json
{
  "id": "...",
  "from": "...",
  "kind": "function",
  "module": "compat/codecs",
  "function": "claudeCodeCodec.decode",
  "args": [{ "allow": ["Read"] }],
  "expect": { "rules": [{ "tool": "Read", "tier": "allow" }] }
}
```

`module` is the module path under `src/` without its extension, and `function` is a dotted path into its exports (`CODECS.opencode.encode`). Exactly one of the following says what the call must do:

- `expect`: the result equals the value.
- `expectUndefined`: the result is `undefined`.
- `checks`: a list of checks on values read from the result by `at`, a list of keys and indices (a final `"length"` of a list or string is its length). A check says exactly one of `equals`, `notEquals`, `contains` (a list of fragments that occur in the string, each after the end of the one before), `subset` (every member of the value is in the result and equal; lists have the same length and match element by element) `absent` (nothing is there), `present` (something is, whatever it is) or `excludes` (a string holds none of the fragments).
- `throws`: the call throws. `name` is the error's `name`, `message` is a list of fragments of its message, `checks` are read from the error object.

`unordered` compares lists without regard to order, for a call whose order is not part of its contract. A `function` case without `args` reads a constant export. `stderr` (`includes`, `absent`) checks what the call wrote to standard error.

`steps`: ordered calls over one set of files, each with the expectations of a `function` case, optionally the `files` to change before it and its own `expectFiles`, so a relation between calls (a second run changing nothing, a warning repeated only when a file changes) is a case. `$map` with `as` and `$ref` carry state between steps.

`layered`: `{ layers | load, files?, expectPolicy?, calls }`. The policy is `mergeLayerPolicies(layers)` (each layer `{ source, policy, ceiling? }`) or `loadPolicy(load)` over the case's files, and every call is decided through `evaluate`, `explain` and a compiled policy, which must agree; `layer` is the source `explain` names for the first step.

`prompt`: `{ policy, root, context?, request, approval?, expect, asked? }`. The permission-prompt handler for the policy answers `request`; `approval` is the answer the host's approval handler gives, and `asked` lists the calls it was asked about (`<tool> <subject> <decision>`), none when the policy settled the call. `expect` is the answer: an allow must equal it exactly, and a deny must hold what it states, with `messageIncludes` as ordered fragments of the message.

`mcp`: `{ args, files?, exchange, stderrIncludes? }`. The MCP server of the command line is started in the first directory with `args` after `mcp`, and `exchange` is played in order: `send` writes one JSON-RPC message as a line, `expect` reads the next line of output and matches it (the string `"$any"` matches anything, objects match key for key), `waitStderr` waits until the standard error holds a text, and `writeFile` changes a file under the server. An `expect` states the ordering the server must keep, and ids are those the sends use.

`watch`: `{ cwd, files?, steps }`. A policy watch starts over the files; each step may `close` it, change `files` (a path to its text, or null to remove it), and states the `reports` that follow: `decisions` (`[tool, input, decision]` each) of a reported policy, or an `error` with ordered message fragments. A step without reports states that nothing is reported. The first step states the initial report.

`evaluate`: `{ policy, tool, input, context?, expect, steps?, layer? }`, with `expect` one of `allow`, `ask` or `deny`. The runner asks `evaluate`, `explain` and a compiled policy, and all three must agree; `steps` is `[command, decision]` for each command of the line, which `explain` and a compiled policy's `explain` must both give.

`shell-differential`: the lines of the shell splitter's differential test with what real bash ran for each (`ran`, the marker functions it called). For every line the splitter does not decline, every marker bash ran must be a command word of the splitter's output, and the share of lines it does not decline is at least `minimumSplittableShare`. The lines are what the original test's generator makes from `seed`, so a port that ports the generator can check that its lines equal these.

`case.schema.json` is the format. A loader accepts no document the schema rejects, and accepts every document the schema accepts for the kinds it validates in full, except one that breaks a rule below; it refuses any other kind rather than passing it unchecked. A corpus file holds at least one case.

### Rules the schema cannot express

Each loader enforces these beside the schema:

- A case id is a name, and is not used twice, within a file or across files.
- `from` is in one of the two forms.
- A manifest's file names are `<area>/<name>.json` with names as above, and its `skip` lists are names in ascending order.
- The corpus matches the manifest.

Integers are at most 2^53-1, the largest the JavaScript runners hold exactly, and an integer written `97.0` is the integer 97, as in JSON Schema.

Every rule above has a negative fixture, and every negative fixture has a repaired twin of the same name that differs by that one defect and is valid, so a fixture cannot stay rejected for another reason: each loader asserts both. A rule about one file has a file in `fixtures/cases/invalid` (twin in `fixtures/cases/repaired`); a rule about the manifest has a file in `fixtures/manifests/invalid` (twin in `fixtures/manifests/repaired`); a rule across files, or between the corpus and its manifest, has a whole corpus root in `fixtures/corpora/invalid` (twin in `fixtures/corpora/repaired`), loaded the way the real corpus is. A file a loader cannot parse counts as rejected, which is how a loader meets bytes that are not UTF-8. A rule added to the format gets a fixture and its twin in the same commit.

## Runners

The TypeScript harness is `src/test/conformance.test.ts`. It loads and checks the corpus with `src/test/conformance-corpus.mjs` (file selection, both schemas in Ajv strict mode, the rules above, the manifest, the fixtures) and supplies the modules under test to the shared runner in `runner/run.mjs`, which executes one case and is at most 16,384 bytes in total, which the same test checks, so it stays a call table and holds no policy logic. The Rust harness is the `agent-perms-conformance` crate under `rust/tests/`, which loads every file, validates it by the same two schemas and the rules above, and refuses a schema keyword it does not support, so a kind is never checked in part; `keywords.rs` proves that per keyword. Both refuse to run as root, since a file mode cannot refuse a read to root.

## Adding a case

Add it to the file for the test file it belongs to, with a fresh `id`, update `manifest.json`, and run the corpus (`pnpm test` runs the TypeScript runner, `sh scripts/rust.sh test` loads and checks every file). When a behaviour changes on purpose, change the case in the same commit as the code.
