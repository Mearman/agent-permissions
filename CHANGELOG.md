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
