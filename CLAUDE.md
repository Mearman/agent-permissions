# Agent Permission Policy Spec — Project Guide

## Overview

A vendor-neutral permission policy format for AI coding agents. One `.agents/permissions.json` file works across Claude Code, OpenAI Codex, OpenCode, Crush, and any agent that adopts the spec. Provides bidirectional codecs to convert between canonical format and each agent's native config.

**Stack**: TypeScript, Zod 4, tsup, Vitest, Node ≥18

## Architecture

```
src/
  schema.ts          # Zod schema — single source of truth for the policy format
  index.ts           # Public API re-exports
  build-schema.ts    # Compiles Zod → JSON Schema (agent-permissions.schema.json)
  compat/
    codecs.ts        # Bidirectional codecs (claude-code, codex, opencode, crush)
  test/
    schema.test.ts               # Schema validation tests
    claude-code-compat.test.ts   # Claude Code round-trip tests
    compat.test.ts               # All codec round-trip tests
spec/examples/       # Example policy files (minimal, full, personal-overrides)
```

### Key principles

- **Zod schema is the source of truth.** `src/schema.ts` defines types and runtime validation. The JSON Schema file (`agent-permissions.schema.json`) is generated via `pnpm build:schema` — never edit it by hand.
- **Codec pattern.** Each agent codec uses `z.codec()` to provide `decode` (native → canonical) and `encode` (canonical → native). All codecs live in `src/compat/codecs.ts`.
- **Claude Code compatibility.** The canonical rule syntax (`Tool(pattern)` strings) and mode values are deliberately compatible with Claude Code's format for zero-translation migration.

## Commands

```bash
pnpm install           # Install dependencies
pnpm test              # Run all tests (Vitest)
pnpm test:watch        # Run tests in watch mode
pnpm check             # Type-check only (tsc --noEmit)
pnpm build             # Build everything (tsup + JSON Schema)
pnpm build:schema      # Regenerate JSON Schema from Zod
pnpm dev               # Build in watch mode (tsup --watch)
```

## Conventions

### Schema and types

- All schema definitions use Zod 4 (`import * as z from "zod"`). Types are inferred via `z.infer<>`, never hand-written interfaces.
- Export both the Zod schema (for runtime use) and the inferred type (for consumer type-checking) from `index.ts`.
- Use `.meta()` on schemas for JSON Schema descriptions and defaults.

### Codecs

- Codec identifiers use kebab-case: `claude-code`, `opencode`, `crush`.
- Each codec must have round-trip tests in `src/test/compat.test.ts`.
- The `CODECS` export maps `AgentId` → codec for programmatic lookup.
- Fidelity is documented: lossless (Claude Code), near-lossless (OpenCode, Codex), lossy (Crush).

### Testing

- Tests use Vitest (`vitest run` for CI, `vitest` for watch).
- Test files live alongside source in `src/test/`.
- Schema tests validate parse success/failure and edge cases.
- Codec tests verify round-trip: `decode(encode(policy))` ≈ `policy`.

### Package structure

- Dual format: ESM (`dist/index.js`) and CJS (`dist/index.cjs`), with types.
- Two entry points: `.` (full API) and `./schema` (schema-only, lighter import).
- JSON Schema file is published as a static asset via the `./agent-permissions.schema.json` export.

## Adding a new agent codec

1. Define the agent's native schema and `AgentId` in `src/compat/codecs.ts`
2. Implement `z.codec(nativeSchema, agentPermissionPolicy, { decode, encode })`
3. Add round-trip tests in `src/test/compat.test.ts`
4. Register in the `CODECS` export map
5. Document fidelity level in README
