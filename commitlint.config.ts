import type { UserConfig } from "@commitlint/types";

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      2,
      "always",
      [
        "schema",
        "codec",
        "compat",
        "loader",
        "evaluate",
        "api",
        "cli",
        "sync",
        "mcp",
        "agent-files",
        "build",
        "release",
        "ci",
        "deps",
      ],
    ],
  },
};

export default config;
