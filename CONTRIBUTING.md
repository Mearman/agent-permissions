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
| `.github/workflows/ci.yml` | The whole pipeline: audit, check, test matrix, release, publishes     |
| `spec/examples/`           | Example policies validated against the schema in tests                |

## Pull requests

CI must be green. The audit job runs `pnpm audit --audit-level high` and fails on any high-severity advisory. It never opens a pull request: clearing an advisory is a change a person or Dependabot proposes, for example an `overrides` entry in `pnpm-workspace.yaml` or a version bump.
