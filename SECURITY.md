# Security Policy

## Supported versions

The latest release on the `latest` channel is the only supported version. Releases are cut automatically from `main` by semantic-release; there are no backport branches.

## Reporting a vulnerability

Report privately through [GitHub security advisories](https://github.com/Mearman/agent-permissions/security/advisories/new) ("Report a vulnerability"). Please do not open a public issue for anything security-sensitive. Include the affected version, a reproduction, and the impact as you understand it; a proof of concept helps but is not required.

## What this package does with trust

`agent-perms` is a policy _toolkit_: it evaluates, converts, and syncs permission configuration files. It never executes the agents whose configs it reads, and the MCP daemon only reads and writes local config files. Treat a vulnerability in rule evaluation (a deny rule that fails closed, a conversion that drops a deny) as security-relevant even without a traditional exploit primitive.

## Supply-chain posture

- Dependency versions must be at least 7 days old before they can resolve (`minimumReleaseAge`), and CI audits at the `high` level, auto-fixing what it can through a PR gated on its own CI run.
- New dependency versions published within the last 7 days cannot be merged by the Dependabot auto-merge workflow, however benign they look.
- The CI token's permissions are scoped per job; the audit job that opens PRs holds the widest grant, and nothing else can push.
