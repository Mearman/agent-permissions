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
- **Releases and the audit fix PR need a `RELEASE_TOKEN` secret.** `main` is protected by a ruleset that requires checks and lets repository admins bypass it, so the release commit and tag cannot be pushed with the workflow's own token, and that token is also not allowed to open pull requests. `RELEASE_TOKEN` is a fine-grained personal access token of a repository admin with read and write access to contents, pull requests and actions on this repository only. Set it with `gh secret set RELEASE_TOKEN --repo Mearman/agent-permissions`; when it is missing or expired the Release job fails at semantic-release's authentication check and the Audit job fails when it opens its fix PR.
- **Formatting** is prettier for YAML/JSON/Markdown and eslint (with the prettier plugin) for TypeScript; `pnpm fix` applies both.
- **The compiled `agent-permissions.schema.json` must be committed in step with `src/schema.ts`** — CI regenerates it and fails on drift, and a golden-file test holds it against the schema source.

## Where things are

| Path                       | Purpose                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `src/schema.ts`            | The Zod schema — single source of truth for the policy format                         |
| `src/compat/`              | Bidirectional codecs for each supported agent                                         |
| `.github/scripts/`         | CI helper scripts (audit auto-fix, dependency age gate), unit-tested from `src/test/` |
| `.github/workflows/ci.yml` | The whole pipeline: audit (self-fixing), check, test matrix, release, publishes       |
| `spec/examples/`           | Example policies validated against the schema in tests                                |

## Pull requests

CI must be green. The audit job will attempt to auto-fix any high-severity dependency advisory by opening its own PR; if your PR fails only on deferred audit findings (warnings, not errors), it is not blocked by them.
