import type { UserConfig } from "@commitlint/types";
import { commitTypes } from "./release.config";

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [2, "always", commitTypes.map((t) => t.type)],
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
