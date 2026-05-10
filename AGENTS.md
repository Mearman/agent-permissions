# Agent Permission Policy Spec — Agent Instructions

## Project Summary

Vendor-neutral permission policy spec for AI coding agents. TypeScript + Zod 4 library providing a canonical schema and bidirectional codecs for Claude Code, Codex, OpenCode, and Crush.

## Key Facts

- **Zod schema is the source of truth** (`src/schema.ts`). Never hand-write TypeScript interfaces — infer from Zod.
- **JSON Schema is generated** (`agent-permissions.schema.json`). Never edit it by hand. Regenerate with `pnpm build:schema`.
- **Codecs live in one file** (`src/compat/codecs.ts`). Each codec is a `z.codec()` with `decode` (native → canonical) and `encode` (canonical → native).
- **`import * as z from "zod"`** — Zod 4 style throughout.

## Commands

```bash
pnpm test              # Vitest — run before committing
pnpm check             # tsc --noEmit type-check
pnpm build             # tsup + JSON Schema generation
pnpm build:schema      # Regenerate agent-permissions.schema.json from Zod
```

## Working in This Codebase

- When modifying the schema, always run `pnpm build:schema` and `pnpm test` afterwards.
- Codec changes require round-trip tests in `src/test/compat.test.ts`.
- New agent codecs: define `AgentId` enum value, implement `z.codec()`, add tests, register in `CODECS` export, document fidelity.
- All fields in the schema are optional. A valid policy can be `{}`. Preserve this when adding new fields.
- Rule syntax uses `Tool(pattern)` strings — keep compatible with Claude Code's format.
- Evaluation order is **deny → ask → allow**. Deny short-circuits.

## Patterns

- Export both Zod schema and inferred type from `index.ts`.
- Use `.meta()` on schema nodes for JSON Schema descriptions and defaults.
- Dual package: ESM + CJS with types. Entry points: `.` (full API) and `./schema` (schema-only).
