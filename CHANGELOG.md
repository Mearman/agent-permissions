## [6.1.2](https://github.com/Mearman/agent-permissions/compare/v6.1.1...v6.1.2) (2026-08-23)

## [6.1.1](https://github.com/Mearman/agent-permissions/compare/v6.1.0...v6.1.1) (2026-08-23)

### Bug Fixes

* **ci:** capture gh pr checks and age-check exit codes without aborting under -e ([9e7a443](https://github.com/Mearman/agent-permissions/commit/9e7a443ff97028ec9a5af1122a4d9dda7bd1ba24)), closes [#16](https://github.com/Mearman/agent-permissions/issues/16)

## [6.1.0](https://github.com/Mearman/agent-permissions/compare/v6.0.4...v6.1.0) (2026-08-23)

### Features

* **ci:** let Dependabot see the actions pinned inside the composite ([f13e056](https://github.com/Mearman/agent-permissions/commit/f13e0564c7ef67c617a00d5d3480b918e5e80ba6))

## [6.0.4](https://github.com/Mearman/agent-permissions/compare/v6.0.3...v6.0.4) (2026-08-23)

### Tests

* add a harmless comment to the composite setup action ([bcd4300](https://github.com/Mearman/agent-permissions/commit/bcd430043d35f7fd032d3d7183b6903cab426032))
* check out the repo before the probe attempts its merge ([9ba3383](https://github.com/Mearman/agent-permissions/commit/9ba3383b57bf691b30552f535e995dc49e684225))
* probe whether GITHUB_TOKEN can merge a PR touching only .github/actions ([3808815](https://github.com/Mearman/agent-permissions/commit/3808815ee82ca9df984f78b86a20b6804bfc3155))

### Chores

* **ci:** remove the token-scope diagnostic workflow ([08f4a1c](https://github.com/Mearman/agent-permissions/commit/08f4a1c7033c135bb148a02c5e808fd0cd8d5e24))

## [6.0.3](https://github.com/Mearman/agent-permissions/compare/v6.0.2...v6.0.3) (2026-08-23)

### Bug Fixes

* **ci:** dispatch a release run after a GITHUB_TOKEN dependency-bump merge ([c96f6de](https://github.com/Mearman/agent-permissions/commit/c96f6de5bd815910e2f0088089e6af1a87a4dbfb))

## [6.0.2](https://github.com/Mearman/agent-permissions/compare/v6.0.1...v6.0.2) (2026-08-23)

### Bug Fixes

* **build:** exempt the release-rewritten plugin manifest from format gating ([f367144](https://github.com/Mearman/agent-permissions/commit/f367144a6f37b80b8946b43d3deb219ae3683a36))
* **ci:** carry the npm registry through the shared setup action ([21a7512](https://github.com/Mearman/agent-permissions/commit/21a7512a0c81482466faf25eaf49f90e6648b837))

## [6.0.1](https://github.com/Mearman/agent-permissions/compare/v6.0.0...v6.0.1) (2026-08-23)

### Bug Fixes

* **ci:** publish the MCP entry through agent-perms and authenticate the registry guard ([a1d7c7c](https://github.com/Mearman/agent-permissions/commit/a1d7c7c41eae75a669fc1308f6db7ecf8bc38196))

## [6.0.0](https://github.com/Mearman/agent-permissions/compare/v5.11.3...v6.0.0) (2026-08-23)

### ⚠ BREAKING CHANGES

* engines.node is now >=24; consumers on Node 18-23 can
no longer install this package.

### Features

* **build:** complete the turbo graph and make pre-push the full gate ([1257f1a](https://github.com/Mearman/agent-permissions/commit/1257f1a1129beeb44ddf55265eea7b250a6a77a9))
* **build:** one eslint gate for every file type, plus knip and package checks ([10182f0](https://github.com/Mearman/agent-permissions/commit/10182f03eaa42986521382eebbf92696cadb3e84))
* **build:** prettier coverage for the YAML, JSON, and Markdown surface ([1e9cdc6](https://github.com/Mearman/agent-permissions/commit/1e9cdc62786240b02b0042f13153d1c86359567c))
* **build:** raise lint to the full strictness set and eliminate every type assertion ([cb42ad1](https://github.com/Mearman/agent-permissions/commit/cb42ad1008b476f2c38dab258b8c3caff86d11c2))
* **ci:** prune inert security overrides instead of accumulating them ([cc750c8](https://github.com/Mearman/agent-permissions/commit/cc750c87e42112f1d65d9865131184d8b858580b))
* **ci:** rebuild the pipeline around a shared setup action and real gates ([37b737b](https://github.com/Mearman/agent-permissions/commit/37b737b9b53cf130ff5fe55ce9d8e33754b9bcb0))
* dogfood the product with a committed .agents/permissions.json ([d757900](https://github.com/Mearman/agent-permissions/commit/d757900872f460b943c17a4957183545483fef06))
* require Node 24, the current LTS, as the baseline ([2825ddc](https://github.com/Mearman/agent-permissions/commit/2825ddc18f95d1c4ce0fd5d4f457e71417d80369))

### Bug Fixes

* **build:** cover plain-JS files, type to the runtime floor, and close the turbo cache gaps ([e525c1a](https://github.com/Mearman/agent-permissions/commit/e525c1aee23a82ad5f92db63b40beb388f09639c))
* **ci:** align action pins and repair output plumbing in the pipeline ([7010001](https://github.com/Mearman/agent-permissions/commit/701000181cedad26c9966370860315b4626ce968))
* **ci:** judge override inertness by the selector and roll back prunes honestly ([c7ac3e9](https://github.com/Mearman/agent-permissions/commit/c7ac3e9a1204c4c34d8f9856fccf4c6fc9ab6a44))
* **ci:** scope the turbo cache key per node version ([ef40087](https://github.com/Mearman/agent-permissions/commit/ef400871724d30ab1d48a98c5797d1043dc99c93))
* **cli:** treat an explicit --help as a successful invocation ([ea0b3ec](https://github.com/Mearman/agent-permissions/commit/ea0b3ec1cff12238591e54a7dff851008866c3a0))
* **pkg:** point the MCP registry entry at the alias that exists ([745bcb4](https://github.com/Mearman/agent-permissions/commit/745bcb41575fc0aa330c3e65aa4260ba2b8404c4))
* **pkg:** restore bare-package resolution with a root exports entry ([3dea947](https://github.com/Mearman/agent-permissions/commit/3dea9479e5f462540479bdf99849f4ec763b5847))
* **release:** accept the pkg scope for package-manifest commits ([f54eccd](https://github.com/Mearman/agent-permissions/commit/f54eccd5626e456bf51f5c1ad294de7f9e3eb777))
* **release:** drive commitlint and semantic-release from one commitTypes source ([bd27df2](https://github.com/Mearman/agent-permissions/commit/bd27df2e8fc06e4649efabf7baf9162caa4faaa1))
* **release:** stamp server.json's version fields on every release ([c20a625](https://github.com/Mearman/agent-permissions/commit/c20a625f41643b8db50ceee1c2086d7f0280327d))

### Documentation

* add a security policy, contributing guide, and LF normalisation ([71aaf07](https://github.com/Mearman/agent-permissions/commit/71aaf072c3d647387914f7bc125f2a60d4e8d49a))

### Tests

* **ci:** unit-test the CI helper scripts' pure logic ([91a66a0](https://github.com/Mearman/agent-permissions/commit/91a66a063c6525e55e9d785df704eddd013b6c91))
* **cli:** run every CLI invocation from a throwaway cwd ([3453086](https://github.com/Mearman/agent-permissions/commit/3453086350f89893bfa41d007cf8fae27f9896af))
* **schema:** hold the committed JSON schema against the schema source ([ffc0cee](https://github.com/Mearman/agent-permissions/commit/ffc0cee3b2cf750605e52e7ce19b855ee3ddae3c))

## [5.11.3](https://github.com/Mearman/agent-permissions/compare/v5.11.2...v5.11.3) (2026-08-23)

### Bug Fixes

* **ci:** skip workflow-file bumps gracefully instead of failing the merge sweep ([80ae9aa](https://github.com/Mearman/agent-permissions/commit/80ae9aac5c489995ac51aeeb0c2579a27c0f0b46))

### CI

* **deps:** bump actions/cache from 5 to 6 ([aced775](https://github.com/Mearman/agent-permissions/commit/aced775539bccc8d47a11fd97d4b3b2805f4e932))
* **deps:** bump actions/checkout from 6 to 7 ([d39fec6](https://github.com/Mearman/agent-permissions/commit/d39fec66c178874cea47d20c84f8debad2b67d97))
* **deps:** bump actions/setup-node from 6 to 7 ([9713547](https://github.com/Mearman/agent-permissions/commit/9713547eda549d1317b065a107bd9d7ecb30d4a6))
* **deps:** bump pnpm/action-setup from 6.0.5 to 6.0.10 ([ab0d655](https://github.com/Mearman/agent-permissions/commit/ab0d65571f5b2053a8730aaa3bf4ff4f38ae5fd7))

## [5.11.2](https://github.com/Mearman/agent-permissions/compare/v5.11.1...v5.11.2) (2026-08-22)

### Bug Fixes

* **ci:** read gh pr checks' verdict from its exit code, not its output ([a26a743](https://github.com/Mearman/agent-permissions/commit/a26a7439b5f4a7f5950d9e1bebba62f0574fdc7c))

## [5.11.1](https://github.com/Mearman/agent-permissions/compare/v5.11.0...v5.11.1) (2026-08-22)

### Bug Fixes

* **ci:** gate the audit fix PR on its own CI run instead of branch protection ([c05322c](https://github.com/Mearman/agent-permissions/commit/c05322c2ba7156a3e7e4c1975f56503d761090a3))

## [5.11.0](https://github.com/Mearman/agent-permissions/compare/v5.10.0...v5.11.0) (2026-08-22)

### Features

* **ci:** land the audit auto-fix through a PR instead of a direct push ([b098e5c](https://github.com/Mearman/agent-permissions/commit/b098e5c08ba83b9d654f1734ae5572c9636d065c))

## [5.10.0](https://github.com/Mearman/agent-permissions/compare/v5.9.5...v5.10.0) (2026-08-22)

### Features

* **ci:** auto-fix aged security overrides and gate merges by dependency age ([6bc4924](https://github.com/Mearman/agent-permissions/commit/6bc4924412c99593b81d6663abd1fc9bb55f6932))

### Bug Fixes

* add bugs.url to package.json for npm metadata ([4dab097](https://github.com/Mearman/agent-permissions/commit/4dab097664864283a0a4bacbec02c3d2e096d642))
* **ci:** stop the audit auto-fix from drifting unrelated dependency versions ([cdddfd9](https://github.com/Mearman/agent-permissions/commit/cdddfd9236a4a0782ea5a7a8af11a987f5655c31))
* **deps:** apply aged security overrides ([d56b679](https://github.com/Mearman/agent-permissions/commit/d56b679be1186c3c6b72947fc17a4c22a0a3459c))
* **deps:** block installs of packages published within the last 7 days ([92a3b8d](https://github.com/Mearman/agent-permissions/commit/92a3b8d1d94109458ac44fb146defbfe433bfeac))

## [5.9.5](https://github.com/Mearman/agent-permissions/compare/v5.9.4...v5.9.5) (2026-05-12)

### Documentation

* fix formatting and SchemaStore link ([ff7c729](https://github.com/Mearman/agent-permissions/commit/ff7c729398b7be3431fef134f38819cc45b58b1f))

## [5.9.4](https://github.com/Mearman/agent-permissions/compare/v5.9.3...v5.9.4) (2026-05-12)

### Chores

* add mcp, mcp-server, sync, crush, zod keywords ([c49bd70](https://github.com/Mearman/agent-permissions/commit/c49bd70b729e6a615796c465bfe68b6478420647))

## [5.9.3](https://github.com/Mearman/agent-permissions/compare/v5.9.2...v5.9.3) (2026-05-12)

### Documentation

* update SchemaStore status — merged ([bba0114](https://github.com/Mearman/agent-permissions/commit/bba0114d8b2b6ac9ef1c4093b939b7a7e174e7ee))

## [5.9.2](https://github.com/Mearman/agent-permissions/compare/v5.9.1...v5.9.2) (2026-05-12)

### Documentation

* add mcp CLI subcommand, fix $schema URL consistency ([41e1e2d](https://github.com/Mearman/agent-permissions/commit/41e1e2d61131ef27a2c565fc475cefa102cf09dc))

## [5.9.1](https://github.com/Mearman/agent-permissions/compare/v5.9.0...v5.9.1) (2026-05-12)

### Documentation

* add MCP server and plugin marketplace installation instructions ([92eaddc](https://github.com/Mearman/agent-permissions/commit/92eaddc4615c9cd42e5f834aae7271bd9b7de435))

## [5.9.0](https://github.com/Mearman/agent-permissions/compare/v5.8.0...v5.9.0) (2026-05-12)

### Features

* **release:** auto-sync plugin.json version via semantic-release ([c2523e8](https://github.com/Mearman/agent-permissions/commit/c2523e8a3ec715b19125f1f4961db2efb4103225))

## [5.8.0](https://github.com/Mearman/agent-permissions/compare/v5.7.0...v5.8.0) (2026-05-12)

### Features

* **mcp:** use npm source for marketplace plugin entry ([65ca648](https://github.com/Mearman/agent-permissions/commit/65ca64854e8b4697e298f87053aa9cd447f9beea))

### Bug Fixes

* **mcp:** remove hardcoded version from plugin.json ([7bc8e27](https://github.com/Mearman/agent-permissions/commit/7bc8e27ed6426300ba888f4d9e17b1291efa1ad3))

## [5.7.0](https://github.com/Mearman/agent-permissions/compare/v5.6.0...v5.7.0) (2026-05-12)

### Features

* **mcp:** add Claude Code marketplace plugin support ([63fb629](https://github.com/Mearman/agent-permissions/commit/63fb6296865a2095a6cac8c976f3f5ad5cd13b4b))

## [5.6.0](https://github.com/Mearman/agent-permissions/compare/v5.5.1...v5.6.0) (2026-05-12)

### Features

* **mcp:** add .mcp.json and server.json for Claude Code plugin support ([94d0386](https://github.com/Mearman/agent-permissions/commit/94d0386ba7af7474df17c8a7f62ef98bf13a8fb4))

## [5.5.1](https://github.com/Mearman/agent-permissions/compare/v5.5.0...v5.5.1) (2026-05-12)

### Chores

* **release:** trigger republish for new alias packages ([6c01ae0](https://github.com/Mearman/agent-permissions/commit/6c01ae0d667d247df8a53ba93b9180f9120bfb81))

## [5.5.0](https://github.com/Mearman/agent-permissions/compare/v5.4.0...v5.5.0) (2026-05-12)

### Features

* **ci:** publish alias packages agent-permissions-mcp, permissions-mcp, permission-mcp ([dd8179f](https://github.com/Mearman/agent-permissions/commit/dd8179f7579f817b5c33f75dfdd99b9debd66d7e))

## [5.4.0](https://github.com/Mearman/agent-permissions/compare/v5.3.0...v5.4.0) (2026-05-12)

### Features

* **mcp:** add MCP sync server and sync config to schema ([4cfca36](https://github.com/Mearman/agent-permissions/commit/4cfca3645b135dd1afcf282eb22a79a22800428f))

## [5.3.0](https://github.com/Mearman/agent-permissions/compare/v5.2.2...v5.3.0) (2026-05-12)

### Features

* **sync:** inject $schema into generated canonical files ([3548e19](https://github.com/Mearman/agent-permissions/commit/3548e19976c007f2d75734974e3611aa78b70752))

## [5.2.2](https://github.com/Mearman/agent-permissions/compare/v5.2.1...v5.2.2) (2026-05-12)

### Chores

* **build:** regenerate JSON schema with with/without/up fields ([e1bca37](https://github.com/Mearman/agent-permissions/commit/e1bca37432369bd7d61e25d2ec3495aad37392aa))
* **deps:** update commitlint scopes for all modules ([8421258](https://github.com/Mearman/agent-permissions/commit/8421258117e077d20202dc5832bb68300a792c9b))

## [5.2.1](https://github.com/Mearman/agent-permissions/compare/v5.2.0...v5.2.1) (2026-05-11)

### Bug Fixes

* **ci:** skip husky hooks in release job ([c081c48](https://github.com/Mearman/agent-permissions/commit/c081c48a0288c5258d1ee0f1a5de0f6e781c48ef))
* **ci:** use --notes-file for release body update ([7690d04](https://github.com/Mearman/agent-permissions/commit/7690d04adf78c1a80fda3527db23e84c1946ac28))

## [5.2.0](https://github.com/Mearman/agent-permissions/compare/v5.1.3...v5.2.0) (2026-05-11)

### Features

* include schema download URL in release body and README ([f4d294d](https://github.com/Mearman/agent-permissions/commit/f4d294d304d873a5fcac28bbbc6fd82e3d74ab84))

## [5.1.3](https://github.com/Mearman/agent-permissions/compare/v5.1.2...v5.1.3) (2026-05-11)

### Bug Fixes

* **ci:** upload schema to GitHub Release via gh CLI ([287bb89](https://github.com/Mearman/agent-permissions/commit/287bb8928bdfbc5ad9313f15f1f58f8983c6f5f3))

## [5.1.2](https://github.com/Mearman/agent-permissions/compare/v5.1.1...v5.1.2) (2026-05-11)

### Bug Fixes

* **ci:** pin Node 22 for release job ([c433edb](https://github.com/Mearman/agent-permissions/commit/c433edbb4c86f373de91954274b1d0454982b0c4))

## [5.1.1](https://github.com/Mearman/agent-permissions/compare/v5.1.0...v5.1.1) (2026-05-11)

### Chores

* gitignore .agents/ test artefacts ([475a353](https://github.com/Mearman/agent-permissions/commit/475a353771dba037c6affd7343203b9d7c4cecf9))

## [5.1.0](https://github.com/Mearman/agent-permissions/compare/v5.0.7...v5.1.0) (2026-05-11)

### Features

* attach schema to GitHub Release assets ([d0d0d41](https://github.com/Mearman/agent-permissions/commit/d0d0d41cd3839036ea0e4c43089d079915f21571))

## [5.0.7](https://github.com/Mearman/agent-permissions/compare/v5.0.6...v5.0.7) (2026-05-11)

### Tests

* add sync branch coverage tests (8 new, 378 total) ([54d8e4f](https://github.com/Mearman/agent-permissions/commit/54d8e4f4e732db4785898429e9e51a89a4ea8533))

## [5.0.6](https://github.com/Mearman/agent-permissions/compare/v5.0.5...v5.0.6) (2026-05-11)

### Tests

* comprehensive CLI tests (39 new, 370 total) ([4699704](https://github.com/Mearman/agent-permissions/commit/469970428fc1e2cef7032e1bfb547bf82f1de9f8))

## [5.0.5](https://github.com/Mearman/agent-permissions/compare/v5.0.4...v5.0.5) (2026-05-11)

### Tests

* add unit tests for agent-files.ts (39 new tests) ([96b76c6](https://github.com/Mearman/agent-permissions/commit/96b76c664fca1828d3161a279041da69fe05cc1f))

## [5.0.4](https://github.com/Mearman/agent-permissions/compare/v5.0.3...v5.0.4) (2026-05-11)

### Refactoring

* extract shared merge utilities into evaluate.ts ([94c50cf](https://github.com/Mearman/agent-permissions/commit/94c50cfe93dc40dc9763b62ecc2a64406374d74a))

## [5.0.3](https://github.com/Mearman/agent-permissions/compare/v5.0.2...v5.0.3) (2026-05-11)

### Refactoring

* shared result types for parseJson, validatePolicy, decodeNative ([bc85871](https://github.com/Mearman/agent-permissions/commit/bc85871f2f43bcb1304b648bb5474f3db7b48e19))

## [5.0.2](https://github.com/Mearman/agent-permissions/compare/v5.0.1...v5.0.2) (2026-05-11)

### Refactoring

* extract per-agent extract/wrap into AgentFileDef ([11f8c00](https://github.com/Mearman/agent-permissions/commit/11f8c00e5e38907843837a75b2a80baae531cedf))

## [5.0.1](https://github.com/Mearman/agent-permissions/compare/v5.0.0...v5.0.1) (2026-05-11)

### Refactoring

* extract shared agent-files module, DRY cli and sync ([c01a077](https://github.com/Mearman/agent-permissions/commit/c01a0778d0b176d872ba9b8fca5e645ffcdf6611))

## [5.0.0](https://github.com/Mearman/agent-permissions/compare/v4.9.0...v5.0.0) (2026-05-11)

### ⚠ BREAKING CHANGES

* — all inputs/outputs via flags, no positional args.

- `--from`/`--input`/`--in` accept format name (finds default file),
  file path, or `-` for stdin
- `--to` accepts format name (writes to default file) or file path
- `--output`/`--out`/`-o` override destination file or `-` for stdout
- `validate --input`/`--in` replaces positional arg
- `check --policy-file` replaces positional arg
- `sync --working-dir`/`-d` replaces positional arg
- Format names resolve to default config file locations (walk-up for input)
- `strict: true` for parseArgs — proper type narrowing via firstString/allStrings

### Features

* rewrite CLI — no positionals, format names resolve to file paths ([8d08397](https://github.com/Mearman/agent-permissions/commit/8d08397bab81f27fb287da4e1602ea5b0e107ab1))

### Documentation

* rewrite CLI section for flag-only, format-to-file resolution ([629f2cc](https://github.com/Mearman/agent-permissions/commit/629f2cc2e896dc88f5cae9e9147b3e0acb9761ec))

## [4.9.0](https://github.com/Mearman/agent-permissions/compare/v4.8.0...v4.9.0) (2026-05-11)

### Features

* resolve --from/--to/--with from agent names or config file paths ([ab69636](https://github.com/Mearman/agent-permissions/commit/ab69636084f7502eecb6f1d46864be52a377c40c))

### Bug Fixes

* enforce strict ESLint — no floating promises, no unused vars, no type assertions ([bcba5d9](https://github.com/Mearman/agent-permissions/commit/bcba5d9f14de8b4f26fa3d22559b6c03d42074a5))
* restore strict ESLint rules — remove assertion and unused-var relaxations ([43b8b00](https://github.com/Mearman/agent-permissions/commit/43b8b0033a937d9b4b3cb7998791e184a77a2a8e))

## [4.8.0](https://github.com/Mearman/agent-permissions/compare/v4.7.1...v4.8.0) (2026-05-11)

### Features

* extract programmatic API from CLI into src/api.ts ([0518661](https://github.com/Mearman/agent-permissions/commit/0518661612fcaf31d1178626abb496664a6c9a9d))

### Documentation

* document programmatic API and sync import in README ([cf9862d](https://github.com/Mearman/agent-permissions/commit/cf9862d8d89705749cede7161f0c72595cd0fe9e))

## [4.7.1](https://github.com/Mearman/agent-permissions/compare/v4.7.0...v4.7.1) (2026-05-11)

### Documentation

* add CLI section to README ([905bf73](https://github.com/Mearman/agent-permissions/commit/905bf73d7a7ecc473e6c10b40b3f0afcc2dbfc8f))

## [4.7.0](https://github.com/Mearman/agent-permissions/compare/v4.6.0...v4.7.0) (2026-05-11)

### Features

* auto-detect input format when --from is omitted ([d7acf2e](https://github.com/Mearman/agent-permissions/commit/d7acf2ed52313b41fe03b6ed2ba1dcdab702f110))

## [4.6.0](https://github.com/Mearman/agent-permissions/compare/v4.5.0...v4.6.0) (2026-05-11)

### Features

* add --out/-o flag to convert for writing output to a file ([0220f3f](https://github.com/Mearman/agent-permissions/commit/0220f3fef1219a35aeba96eb201a87cc12188674))

## [4.5.0](https://github.com/Mearman/agent-permissions/compare/v4.4.0...v4.5.0) (2026-05-11)

### Features

* add --compact and --verbose flags to convert command ([7db8c2d](https://github.com/Mearman/agent-permissions/commit/7db8c2d54bb43b8f847bf88a9f479b14c31dca04))

## [4.4.0](https://github.com/Mearman/agent-permissions/compare/v4.3.1...v4.4.0) (2026-05-11)

### Features

* add shorthand flags for all CLI options ([4351111](https://github.com/Mearman/agent-permissions/commit/4351111c4af914cf39bc2eed111ff818d6cc9a81))

## [4.3.1](https://github.com/Mearman/agent-permissions/compare/v4.3.0...v4.3.1) (2026-05-11)

### Refactoring

* split flag semantics between convert and sync ([c2a6cb3](https://github.com/Mearman/agent-permissions/commit/c2a6cb356ff3ed5dd33341c4677ff01c81bf19a5))

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
