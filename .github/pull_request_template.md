<!-- The commit messages are what land in the changelog, so put the real explanation there. This template is for what a reviewer needs that the diff and the commits do not already say. -->

## What this changes

<!-- Which part of the spec/tooling (schema, evaluator, a codec, the CLI, the MCP sync daemon), and what behaviour differs afterwards. -->

## Why

<!-- The problem, not the patch. Link the issue if there is one -- use `Fixes #N` so the issue closes and the Development panel links up. -->

## Notes for review

<!-- Anything a reviewer would otherwise have to reconstruct: a decision you made and rejected alternatives for, a place the change is deliberately narrower than it looks, a construct you chose to drop rather than half-support. Delete if there is nothing. -->

---

- [ ] Commits are conventional, and the scope matches one of `commitlint.config.ts`'s `scope-enum` list -- commitlint gates this.
- [ ] A behaviour change has a test that fails without it.
- [ ] A breaking change says so in the commit body (`BREAKING CHANGE:`), since that is what drives the next major version.
- [ ] `agent-permissions.schema.json` is regenerated and committed if `src/schema.ts` changed -- CI fails on drift between the two.
- [ ] A new or changed codec has round-trip tests in `src/test/compat.test.ts` (decode then encode, and encode then decode, agree with the canonical form).
- [ ] A new agent codec followed the [checklist in README.md](../README.md#adding-a-new-agent-codec) and is registered in the `CODECS` export.
