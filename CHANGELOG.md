## [4.3.0](https://github.com/Mearman/agent-permissions/compare/v4.2.0...v4.3.0) (2026-05-11)

### Features

* add sync command for bidirectional agent config merging ([b807287](https://github.com/Mearman/agent-permissions/commit/b807287ed880fa2124ca41c17a5f78331ba15406))

### Tests

* add 11 tests for sync command ([869bb85](https://github.com/Mearman/agent-permissions/commit/869bb85a1e1e777b3e79d06fe1f0219db493bfb5))

## [4.2.0](https://github.com/Mearman/agent-permissions/compare/v4.1.0...v4.2.0) (2026-05-11)

### Features

* add Kiro codec — decode/encode Amazon Kiro agent configs ([7cc4f6e](https://github.com/Mearman/agent-permissions/commit/7cc4f6ec9b9295725c4c4b655cc1a0120e3c2562))

## [4.1.0](https://github.com/Mearman/agent-permissions/compare/v4.0.0...v4.1.0) (2026-05-11)

### Features

* add CLI binary for converting, validating, and checking policies ([fb4b086](https://github.com/Mearman/agent-permissions/commit/fb4b0861a52dfcbaeec3946168475e93fe39ecb6))
* add ruleToString and collectRules helpers to evaluate module ([200eb9e](https://github.com/Mearman/agent-permissions/commit/200eb9eaa3806337be3122b2e4a7e8a6e6eda26d))

### Bug Fixes

* make test task depend on build for CLI binary ([0bf1984](https://github.com/Mearman/agent-permissions/commit/0bf1984a1ad5f5e958c85fd136264a605199c67e))

### Refactoring

* codecs produce/consume unified rules[] instead of permissions tiers ([2ef38e4](https://github.com/Mearman/agent-permissions/commit/2ef38e4652e91d78b83cd95e1729f3cdc8b54297))

### Tests

* rewrite compat tests for unified rules, add CLI tests ([a220986](https://github.com/Mearman/agent-permissions/commit/a2209867c8afecaccacda72c9b04b67e66f0cd78))

## [4.0.0](https://github.com/Mearman/agent-permissions/compare/v3.0.6...v4.0.0) (2026-05-10)

### ⚠ BREAKING CHANGES

* PermissionPolicy now uses rules[] instead of permissions.allow/deny/ask.
The permissions field is still accepted by the schema (zero-translation migration preserved)
but the loader normalises it into rules on output.

- Schema: conditionalRule → Rule (pattern is optional, no longer conditional)
- Schema: PascalCase for both const and type (declaration merging)
- Evaluator: processes unified rules array, deny → ask → allow
- Loader: normalises permissions string arrays into Rule objects
- normaliseStringRule() exported for converting string rules to structured rules

### Features

* unify rules and permissions into single rules array ([d33ee13](https://github.com/Mearman/agent-permissions/commit/d33ee138065ba076abef644c86613d8c56d8bee1))

### Documentation

* rewrite README and examples for unified rules format ([96a08b2](https://github.com/Mearman/agent-permissions/commit/96a08b2bb29212ab4813778b4df4dea3867ea5b1))

### Chores

* regenerate JSON Schema from unified rules schema ([6ac886a](https://github.com/Mearman/agent-permissions/commit/6ac886a73c5281f740f2bd0f6267e04971d6069f))

## [3.0.6](https://github.com/Mearman/agent-permissions/compare/v3.0.5...v3.0.6) (2026-05-10)

### Documentation

* show rules in quick-start example, add unconditional rule example ([b5352d3](https://github.com/Mearman/agent-permissions/commit/b5352d343f619bc7cdded9e16f412e15f84c5bc1))

## [3.0.5](https://github.com/Mearman/agent-permissions/compare/v3.0.4...v3.0.5) (2026-05-10)

### Chores

* add LICENSE file, remove license section from README ([664f27e](https://github.com/Mearman/agent-permissions/commit/664f27e5b941f01be0bb4dca8b8bc184452d6e6b))

## [3.0.4](https://github.com/Mearman/agent-permissions/compare/v3.0.3...v3.0.4) (2026-05-10)

### Chores

* add commit-msg and pre-push husky hooks ([f3f2809](https://github.com/Mearman/agent-permissions/commit/f3f280994265b24f5c814d18f41783b1fc40b140))

## [3.0.3](https://github.com/Mearman/agent-permissions/compare/v3.0.2...v3.0.3) (2026-05-10)

### Bug Fixes

* align codecs with upstream agent source code ([d08a4a1](https://github.com/Mearman/agent-permissions/commit/d08a4a18793396ecabd8a0b3175f5271f79c64d7))
* use SDK imports for OpenCode v2 alignment ([9dc6c6d](https://github.com/Mearman/agent-permissions/commit/9dc6c6dbb972e238616ea09927d99363fd83fd28))

### Styles

* remove extra blank line in codecs.ts ([eea6a9f](https://github.com/Mearman/agent-permissions/commit/eea6a9f78d0dd0b69b1e99583e86b97b0ed238cd))

## [3.0.2](https://github.com/Mearman/agent-permissions/compare/v3.0.1...v3.0.2) (2026-05-10)

### Documentation

* add npm version, license, and CI badges ([9276865](https://github.com/Mearman/agent-permissions/commit/9276865d4d58fee6ce4de5ac67861dcfbcb6376d))
* fix codec API to use .decode()/.encode() ([dbd701e](https://github.com/Mearman/agent-permissions/commit/dbd701e76a7445577a31c91fff4244b5cec39a80))
* rewrite README for v3 — wildcard exports, evaluator, loader, escape sequences ([2775197](https://github.com/Mearman/agent-permissions/commit/27751972c8dd005bec1929263e5cc0c3a6630542))

## [3.0.1](https://github.com/Mearman/agent-permissions/compare/v3.0.0...v3.0.1) (2026-05-10)

### Bug Fixes

* escape sequence handling in rule parser ([d6b21ad](https://github.com/Mearman/agent-permissions/commit/d6b21adbd05f38d0c202a0e5bf010de1cbe79d55))

## [3.0.0](https://github.com/Mearman/agent-permissions/compare/v2.0.1...v3.0.0) (2026-05-10)

### ⚠ BREAKING CHANGES

* rule matching now follows Claude Code's three rule types:
  - Exact: Tool(command) — string equality
  - Prefix: Tool(prefix:*) — word-boundary enforced prefix match
  - Wildcard: Tool(pattern * middle *) — regex with .* for unescaped *

New features:
  - Escape sequences: \( \) \* \\ in rule content
  - Conditional rules (rules[]) with when.cwd and when.branch conditions
  - MCP server-level wildcards (mcp__*__delete*)
  - Domain patterns (domain:example.com)
  - Trailing * matches bare command (git * matches both git and git add)
  - matchPattern() for input-only matching (conditional rules)
  - 209 tests (189 existing + 20 new Claude Code syntax + conditional tests)

### Features

* rewrite evaluator with Claude Code rule syntax ([f9f0fad](https://github.com/Mearman/agent-permissions/commit/f9f0fadaaf072c665013882f4b5cba5307dfae72))

## [2.0.1](https://github.com/Mearman/agent-permissions/compare/v2.0.0...v2.0.1) (2026-05-10)

### Bug Fixes

* **ci:** remove prepublishOnly — CI validates before release ([d5d5a32](https://github.com/Mearman/agent-permissions/commit/d5d5a329f9b970f27b9e8e5b9b876fda0b6f90eb))

## [2.0.0](https://github.com/Mearman/agent-permissions/compare/v1.2.0...v2.0.0) (2026-05-10)

### ⚠ BREAKING CHANGES

* consumers must now import from specific subpaths:
  - `agent-perms/schema` — Zod schemas and types
  - `agent-perms/evaluate` — deny-first evaluator
  - `agent-perms/loader` — multi-layer policy loader
  - `agent-perms/compat/codecs` — bidirectional codecs
  - `agent-perms/compat/enums` — SDK-aligned enums

Wildcard export `./*` maps to `./dist/*.mjs` / `./dist/*.cjs`.
tsdown builds all source files as separate entry points.
No more barrel coupling — each module is independently importable.

### Features

* remove barrel index.ts, use wildcard package exports ([f072eaa](https://github.com/Mearman/agent-permissions/commit/f072eaa07e62fbdd31b419df0c1b341e7ffa0e0b))

## [1.2.0](https://github.com/Mearman/agent-permissions/compare/v1.1.0...v1.2.0) (2026-05-10)

### Features

* add test coverage with node --experimental-test-coverage ([3d2784e](https://github.com/Mearman/agent-permissions/commit/3d2784efbab42e94367a690bcad036c3ecb23f0d))

## [1.1.0](https://github.com/Mearman/agent-permissions/compare/v1.0.1...v1.1.0) (2026-05-10)

### Features

* add evaluate and loader modules ([75b4dee](https://github.com/Mearman/agent-permissions/commit/75b4dee31205b8cdadb8b5f1ac79c71c3afebb86))

## [1.0.1](https://github.com/Mearman/agent-permissions/compare/v1.0.0...v1.0.1) (2026-05-10)

### Chores

* bump version to 1.0.1 ([8cdd4ec](https://github.com/Mearman/agent-permissions/commit/8cdd4ec45d4fb3a3c34c4f4a611e10477b7221dd))

## 1.0.0 (2026-05-10)

### Features

* add bidirectional Zod codecs for Claude Code, OpenCode, Crush ([9232315](https://github.com/Mearman/agent-permissions/commit/9232315f4a7d555d2247b9f9ee366a7c5a7d90b3))
* add Claude Code compatibility tests (72 tests passing) ([81859c3](https://github.com/Mearman/agent-permissions/commit/81859c302107c35725889f56772fdc5f54cea187))
* add Codex (OpenAI) codec — TOML-native permission mapping ([c7a7a48](https://github.com/Mearman/agent-permissions/commit/c7a7a489f267fc5447a368160fd456f877ed9e4d))
* add sandbox, profiles, network, per-agent overrides to spec ([725667d](https://github.com/Mearman/agent-permissions/commit/725667d9db1f537d32067c58a3a79d0ba26edaac))
* **ci:** multi-registry publishing, single-package layout ([27bad51](https://github.com/Mearman/agent-permissions/commit/27bad51eb4e0befd6edb5f78197891e04c9fdc6b))
* **compat:** add OpenCode SDK alignment checks ([9b869da](https://github.com/Mearman/agent-permissions/commit/9b869dac76ea21c2ec0731675ae72d995098cddc))
* Zod schema with compiled JSON Schema, examples, and tests ([364df32](https://github.com/Mearman/agent-permissions/commit/364df32e764cbc2cd87323c067f9a6f4a45773b9))

### Bug Fixes

* accept defaultMode inside permissions for Claude Code compatibility ([62bbbd4](https://github.com/Mearman/agent-permissions/commit/62bbbd4e2b93c3323fa4a42d8399a1238ee78825))
* **ci:** OIDC publishing — no NPM_TOKEN, separate GitHub Packages job ([3f3eaa5](https://github.com/Mearman/agent-permissions/commit/3f3eaa5ec892fae49b56b759b54049e5878a1a37))
* **ci:** track .tool-versions for setup-node node-version-file ([0e1c06b](https://github.com/Mearman/agent-permissions/commit/0e1c06bcbebd48369be647e620a26a6cf2ff612e))

### Documentation

* add CLAUDE.md and AGENTS.md project guides for coding agents ([9ec163a](https://github.com/Mearman/agent-permissions/commit/9ec163a7cb8086af49d0b93044a827388d4d4ea8))
* add README with quick start, schema overview, codec usage, examples ([08cca87](https://github.com/Mearman/agent-permissions/commit/08cca87da8ca5642f4cf6df3913aa02aa5016408))
* symlink CLAUDE.md → AGENTS.md (single source of truth) ([94e0d19](https://github.com/Mearman/agent-permissions/commit/94e0d1951dafd5eeb7b7788fd708d45cd37bf8ab))
* symlink CLAUDE.md and AGENTS.md → README.md (single source of truth) ([8616302](https://github.com/Mearman/agent-permissions/commit/86163025d82b76fc98a235e0dcb957e162ed9f9c))

### Tests

* add comprehensive round-trip tests for all four codecs ([4288a6f](https://github.com/Mearman/agent-permissions/commit/4288a6fb5bcfd4ee625199c8908596ed4131bed6))

### Build

* add CI, linting, SDK alignment checks, and strict types ([462dc86](https://github.com/Mearman/agent-permissions/commit/462dc860c501950a7cb8948e2cc6dfffe98c4b15))
* fold schema compilation into tsdown plugin, remove build-schema.ts ([8ab65be](https://github.com/Mearman/agent-permissions/commit/8ab65beb0f0cfa2970824604ce044e2a8e226cad))
* migrate to node:test runner, drop vitest dependency ([53075fc](https://github.com/Mearman/agent-permissions/commit/53075fc2e41523bf744bb8cf9a31d96246b54743))
* switch to tsdown, dual ESM+CJS output, package.json for publishing ([b2a6536](https://github.com/Mearman/agent-permissions/commit/b2a6536356304fe57266eaeec665e50f91f78464))

### Chores

* add CLAUDE.md and AGENTS.md negation rules to .gitignore ([b2ebe46](https://github.com/Mearman/agent-permissions/commit/b2ebe461cd4e3ac0991c49f011174c395a26a1a5))
* set package name to agent-perms, repo to Mearman/agent-permissions-spec ([203f6b1](https://github.com/Mearman/agent-permissions/commit/203f6b1d4f30429814244e9e29fa495d9e155be3))
