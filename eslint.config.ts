import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintPluginPrettier from "eslint-plugin-prettier";
import { configs } from "typescript-eslint";

const configFiles = [
  "eslint.config.ts",
  "commitlint.config.ts",
  "release.config.ts",
  "lint-staged.config.ts",
  "tsdown.config.ts",
];

const sharedPlugins = {
  prettier: eslintPluginPrettier,
};

const sharedRules = {
  "prettier/prettier": "error",
};

export default defineConfig(
  { ignores: ["dist/", "node_modules/", "coverage/"] },

  // Source and test files
  {
    files: ["src/**/*.ts"],
    extends: [
      eslint.configs.recommended,
      ...configs.strictTypeChecked,
      ...configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: sharedPlugins,
    rules: {
      ...sharedRules,
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Test-specific overrides
  {
    files: ["src/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/consistent-type-assertions": "off",
    },
  },

  // Config files — no tsconfig, use allowDefaultProject
  {
    files: configFiles,
    extends: [
      eslint.configs.recommended,
      ...configs.strictTypeChecked,
      ...configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: configFiles },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: sharedPlugins,
    rules: sharedRules,
  },

  {
    files: ["src/**/*.ts"],
    linterOptions: {
      noInlineConfig: true,
    },
  },
  eslintConfigPrettier,
);
