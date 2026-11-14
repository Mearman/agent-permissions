import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { sync } from "../sync.ts";
import {
  cleanup,
  denyRm,
  options,
  project,
  put,
} from "./native-config-fixture.ts";

after(cleanup);

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

/** A project directory beneath a parent that holds the files an ancestor would. */
async function nested(): Promise<{ parent: string; cwd: string }> {
  const parent = await project({});
  const cwd = join(parent, "app");
  await mkdir(join(cwd, ".agents"), { recursive: true });
  await writeFile(
    join(cwd, ".agents", "permissions.json"),
    JSON.stringify({ rules: [denyRm] }),
  );
  return { parent, cwd };
}

void describe("a source that sync would not write never stops it", () => {
  void it("skips an ancestor's file that cannot be read", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root can read any file");
      return;
    }
    const { parent, cwd } = await nested();
    const bad = await put(parent, "opencode.json", "{}");
    await chmod(bad, 0o200);
    try {
      const output = await stderrOf(() =>
        sync(options(cwd, { up: Infinity, create: true })),
      );
      assert.match(output, /warning: .*opencode\.json.*cannot be read/u);
      assert.equal(
        (await readFile(join(cwd, "opencode.json"), "utf-8")).includes("rm"),
        true,
      );
    } finally {
      await chmod(bad, 0o600);
    }
  });
});
