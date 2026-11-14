import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { MODELLED_PATHS } from "../compat/codecs.ts";
import { cleanup } from "./native-config-fixture.ts";

after(cleanup);

/** The file each agent's modelled paths live in, and a value that restricts at one path. */
const FILES: Record<
  "claude-code" | "opencode" | "kiro",
  {
    file: string;
    restrictive: (path: readonly string[]) => unknown;
  }
> = {
  "claude-code": {
    file: ".claude/settings.json",
    restrictive: (path) =>
      path.at(-1) === "deny" || path.at(-1) === "ask"
        ? ["Bash(rm:*)"]
        : undefined,
  },
  opencode: {
    file: "opencode.json",
    restrictive: (path) =>
      path.at(-1) === "external_directory" ? undefined : "deny",
  },
  kiro: {
    file: ".kiro/permissions.json",
    restrictive: (path) => {
      const leaf = path.at(-1) ?? "";
      if (leaf === "denyByDefault") return true;
      return /^(denied|blocked)/u.test(leaf) || leaf === "blocked"
        ? ["rm"]
        : undefined;
    },
  },
};

void describe("a restriction at a modelled path survives a sync with nothing else to merge", () => {
  for (const [agent, { restrictive }] of Object.entries(FILES)) {
    const paths: readonly (readonly string[])[] =
      agent === "claude-code"
        ? MODELLED_PATHS["claude-code"]
        : agent === "opencode"
          ? MODELLED_PATHS.opencode
          : MODELLED_PATHS.kiro;
    const sampled = paths.filter((path) => restrictive(path) !== undefined);

    void it(`has restrictive paths to check for ${agent}`, () => {
      assert.ok(sampled.length > 0);
    });
  }
});
