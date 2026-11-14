# Contributing

## Setup

Requires Node 24+ (LTS) and pnpm 11 (pinned via `packageManager` — corepack or pnpm itself will pick up the right version).

```sh
pnpm install
pnpm check     # typecheck + lint + build (turbo-cached)
pnpm test
```

## The loop

Make the change, run `pnpm check` and `pnpm test`, commit. The pre-push hook runs the full validation set — expect it to catch anything the per-commit pass missed.

- **Conventional commits are enforced** by commitlint; the allowed types and their release effects come from one list (`commitTypes` in `release.config.ts`), so a type that is accepted always has a defined release meaning. Breaking changes use the `BREAKING CHANGE:` footer (or `!`), which cuts a major version.
- **Releases are automatic.** Every merge to `main` that contains a releasable commit triggers semantic-release, which publishes to npm, cuts the GitHub release (with the compiled JSON Schema attached), and commits the version bump back to `main`.
- **Releases push over SSH with a deploy key.** `main` is protected by a ruleset that requires checks and lets repository admins and deploy keys bypass it, so the release commit and tag cannot be pushed with the workflow's own token. The Release job checks out with the write deploy key named `release`, whose private half is the `RELEASE_DEPLOY_KEY` secret; the ruleset lists deploy keys as a bypass actor. To rotate it, generate a new ed25519 key pair, replace the deploy key with `gh repo deploy-key add --allow-write`, and replace the secret with `gh secret set RELEASE_DEPLOY_KEY`. When the key or secret is missing, the Release job fails at checkout.
- **Formatting** is prettier for YAML/JSON/Markdown and eslint (with the prettier plugin) for TypeScript; `pnpm fix` applies both.
- **The compiled `agent-permissions.schema.json` must be committed in step with `src/schema.ts`** — CI regenerates it and fails on drift, and a golden-file test holds it against the schema source.

## Where things are

| Path                       | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `src/schema.ts`            | The Zod schema — single source of truth for the policy format         |
| `src/compat/`              | Bidirectional codecs for each supported agent                         |
| `.github/scripts/`         | CI helper scripts (dependency age gate), unit-tested from `src/test/` |
| `rust/`                    | The Rust workspace and its `deny.toml` allowlist                      |
| `scripts/`                 | `rust.sh`, the one place cargo runs, and the guards that check it     |
| `.github/workflows/ci.yml` | The whole pipeline: audit, check, test matrix, release, publishes     |
| `spec/examples/`           | Example policies validated against the schema in tests                |

## Rust

The Rust workspace under `rust/` is built and tested by cargo, never through pnpm. Every cargo command runs through `sh scripts/rust.sh <check>` (`fmt`, `clippy`, `test`, `deny`), against the committed `Cargo.lock` and the toolchain `rust/rust-toolchain.toml` pins, and `sh scripts/rust-checks.sh` runs the guards and every check as CI's `Rust` job does. A new crate takes its settings from the workspace (`[lints] workspace = true`, and `edition`, `rust-version` and `license` inherited), and a new dependency is added to `rust/deny.toml` with its reason in the same change; the `cargo-deny` job fails on a crate that is not listed and on a listed crate nothing uses. The pre-push hook runs the Rust checks when the pushed commits touch `rust/`, `conformance/`, `scripts/`, the Rust workflows or the hook itself, and then needs [rustup](https://rustup.rs) and Python 3.9 or later. The `Advisories` workflow reads the RustSec database on a schedule and when the lock file changes, and is not a required check.

## Pull requests

CI must be green. The audit job runs `pnpm audit --audit-level high` and fails on any high-severity advisory. It never opens a pull request: clearing an advisory is a change a person or Dependabot proposes, for example an `overrides` entry in `pnpm-workspace.yaml` or a version bump.
