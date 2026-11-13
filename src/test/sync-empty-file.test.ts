import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sync } from "../sync.ts";
import {
  allowRead,
  cleanup,
  denyRm,
  options,
  project,
  put,
} from "./native-config-fixture.ts";

after(cleanup);

/** Run a sync and return what it wrote to stderr. */
async function stderrOf(run: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (data: string | Uint8Array): boolean => {
    chunks.push(String(data));
    return true;
  };
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

const BLANKS = ["", "  \n\t\n", "﻿"];

void describe("an empty config file has one meaning: no settings", () => {
  for (const path of [
    ".claude/settings.json",
    "opencode.json",
    ".kiro/permissions.json",
    ".omp/config.yml",
  ]) {
    for (const blank of BLANKS) {
      const label = JSON.stringify(blank);
      void it(`is written as a new document as a target: ${path} holding ${label}`, async () => {
        const cwd = await project({ rules: [denyRm] });
        const file = await put(cwd, path, blank);

        await sync(options(cwd, { create: true }));

        const text = await readFile(file, "utf-8");
        assert.match(text, /rm/u);
      });

      void it(`contributes nothing, without a warning, as a source: ${path} holding ${label}`, async () => {
        const cwd = await project({ rules: [allowRead] });
        await put(cwd, path, blank);

        const output = await stderrOf(() => sync(options(cwd)));

        assert.doesNotMatch(output, /skipped|invalid/u);
        const canonical: unknown = JSON.parse(
          await readFile(join(cwd, ".agents", "permissions.json"), "utf-8"),
        );
        assert.deepEqual(
          typeof canonical === "object" && canonical !== null
            ? Object.fromEntries(Object.entries(canonical)).rules
            : undefined,
          [allowRead],
        );
      });
    }
  }

  void it("is a canonical file with no settings, which sync fills in", async () => {
    const cwd = await project({});
    await put(cwd, ".agents/permissions.json", " \n");
    await put(
      cwd,
      ".claude/settings.json",
      JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
    );

    const output = await stderrOf(() => sync(options(cwd)));

    assert.doesNotMatch(output, /skipped|invalid/u);
    const canonical = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    assert.match(canonical, /rm/u);
  });
});
