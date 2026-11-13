import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sync } from "../sync.ts";
import { MODELLED_PATHS } from "../compat/codecs.ts";
import {
  cleanup,
  json,
  options,
  project,
  put,
} from "./native-config-fixture.ts";

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

/** Nest a value at a path of keys. */
function nest(
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  return path.reduceRight<Record<string, unknown>>(
    (inner, key, index) =>
      index === path.length - 1 ? { [key]: value } : { [key]: inner },
    {},
  );
}

function at(root: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      typeof node === "object" && node !== null
        ? Object.fromEntries(Object.entries(node))[key]
        : undefined,
    root,
  );
}

void describe("a restriction at a modelled path survives a sync with nothing else to merge", () => {
  for (const [agent, { file, restrictive }] of Object.entries(FILES)) {
    const payload =
      agent === "claude-code"
        ? ["permissions"]
        : agent === "opencode"
          ? ["permission"]
          : [];
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

    for (const path of sampled) {
      const full = [...payload, ...path];
      void it(`keeps ${agent}: ${full.join(".")}`, async () => {
        const cwd = await project({});
        const value = restrictive(path);
        await put(cwd, file, JSON.stringify(nest(full, value)));

        await sync(options(cwd));

        const written = await json(join(cwd, file));
        const kept = at(written, full);
        assert.notEqual(kept, undefined, `${full.join(".")} was removed`);
        assert.notDeepEqual(kept, []);
      });
    }
  }

  void it("leaves OpenCode's list and websearch, which the codec folds into other tools, untouched", async () => {
    const cwd = await project({});
    await put(
      cwd,
      "opencode.json",
      JSON.stringify({ permission: { list: "deny", websearch: "ask" } }),
    );

    await sync(options(cwd));

    const written = await json(join(cwd, "opencode.json"));
    // The codec writes `bash: "ask"` for a policy with no rules; the two keys it cannot round-trip stay.
    assert.deepEqual(written.permission, {
      bash: "ask",
      list: "deny",
      websearch: "ask",
    });
  });
});
