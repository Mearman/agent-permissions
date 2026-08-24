import eslint from "@eslint/js";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import { defineConfig, includeIgnoreFile } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import depend from "eslint-plugin-depend";
import { configs } from "typescript-eslint";
import * as yamlEslintParser from "yaml-eslint-parser";

export default defineConfig(
  // Everything .gitignore already excludes, rather than a second hand-maintained copy of it.
  includeIgnoreFile(new URL(".gitignore", import.meta.url).pathname),

  // Tracked but not ours to format: the generated schema's formatting is owned by the tsdown plugin that writes it, the lockfile by pnpm, and CHANGELOG.md by semantic-release's exec plugin (jq) at release time. None of these are gitignored, so includeIgnoreFile above can't exclude them.
  {
    ignores: [
      "coverage/",
      "agent-permissions.schema.json",
      "pnpm-lock.yaml",
      "CHANGELOG.md",
      ".claude-plugin/plugin.json",
    ],
  },

  {
    // Inline disables are banned repo-wide: a rule that genuinely cannot hold gets a scoped block below with its reasoning, which is reviewable, instead of a line comment that rots invisibly. No `files` key, so this applies to every linted file type (TS, JS, JSON, Markdown, YAML), not just the typed TS program.
    linterOptions: {
      noInlineConfig: true,
    },
  },

  {
    // Every TypeScript file that participates in the program: src, the CI helper scripts, and the root-level config files themselves, so a bad release or commitlint config is caught by the same gate as library code.
    files: ["src/**/*.ts", ".github/scripts/**/*.ts", "*.config.ts"],
    extends: [
      eslint.configs.recommended,
      ...configs.strictTypeChecked,
      ...configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // projectService resolves each file into the tsconfig program that includes it; the root config files now sit in tsconfig.json's include, so no allowDefaultProject shim is needed for them.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      prettier: eslintPluginPrettier,
    },
    rules: {
      "prettier/prettier": "error",
      // No type assertions anywhere: narrow with a guard or fix the types. The type-safety rules in the user's own standard that this repository is held to.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 10,
        },
      ],
    },
  },

  {
    // Plain JavaScript (scripts/smoke-dist.mjs and any future tooling): recommended rules plus prettier, so no file type in the repo escapes the one gate.
    files: ["**/*.{js,mjs,cjs}"],
    extends: [eslint.configs.recommended],
    plugins: {
      prettier: eslintPluginPrettier,
    },
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
    },
    rules: {
      "prettier/prettier": "error",
    },
  },

  {
    // Tests legitimately assert on shapes the compiler already knows: type assertions and non-null assertions are allowed here without inline escapes, and unused destructured fields are common in table-driven cases.
    files: ["src/test/**/*.ts", ".github/scripts/*.test.ts"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": "off",
    },
  },

  {
    // Prettier runs through the eslint prettier plugin here too (the plugin supports the json language), so one gate and one --fix covers JSON as well.
    files: ["**/*.json"],
    plugins: { json, prettier: eslintPluginPrettier },
    language: "json/json",
    rules: {
      "json/no-duplicate-keys": "error",
      "json/no-empty-keys": "error",
      "prettier/prettier": "error",
    },
  },

  {
    files: ["**/*.md"],
    plugins: { markdown, prettier: eslintPluginPrettier },
    language: "markdown/gfm",
    rules: {
      "markdown/no-html": "error",
      "prettier/prettier": "error",
    },
  },

  {
    // Workflow and workspace YAML: parsed by yaml-eslint-parser (a parser, not a language -- YAML is JS-representable), syntax-checked by the parse itself and formatted by prettier through the same plugin.
    files: ["**/*.yaml", "**/*.yml"],
    plugins: { prettier: eslintPluginPrettier },
    languageOptions: {
      parser: yamlEslintParser,
    },
    rules: {
      "prettier/prettier": "error",
    },
  },

  {
    files: ["package.json"],
    plugins: { depend },
    rules: {
      // lint-staged sits on module-replacements' deprecation list, but it is this repo's deliberately chosen pre-commit runner and is actively maintained — the list's opinion does not apply here.
      "depend/ban-dependencies": ["error", { allowed: ["lint-staged"] }],
    },
  },

  eslintConfigPrettier,
);
