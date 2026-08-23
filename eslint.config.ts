import eslint from "@eslint/js";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import depend from "eslint-plugin-depend";
import { configs } from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "node_modules/", "coverage/"] },

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
    // Inline disables are banned: a rule that genuinely cannot hold gets a scoped block below with its reasoning, which is reviewable, instead of a line comment that rots invisibly.
    linterOptions: {
      noInlineConfig: true,
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
    // Tests legitimately assert on shapes the compiler already knows: type assertions and non-null assertions are allowed here without inline escapes, and unused destructured fields are common in table-driven cases.
    files: ["src/test/**/*.ts", ".github/scripts/*.test.ts"],
    rules: {
      "@typescript-eslint/consistent-type-assertions": "off",
    },
  },

  {
    files: ["**/*.json"],
    ignores: ["pnpm-lock.yaml", "package-lock.json"],
    plugins: { json },
    language: "json/json",
    rules: {
      "json/no-duplicate-keys": "error",
      "json/no-empty-keys": "error",
    },
  },

  {
    files: ["**/*.md"],
    plugins: { markdown },
    language: "markdown/gfm",
    rules: {
      "markdown/no-html": "error",
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
