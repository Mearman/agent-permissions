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

const UNDECODABLE = JSON.stringify({ permissions: { allow: "Read" } });

void describe("a source that sync would not write never stops it", () => {
  void it("skips an ancestor's undecodable settings with a warning naming the file and the reason, and still writes", async () => {
    const { parent, cwd } = await nested();
    const bad = await put(parent, ".claude/settings.json", UNDECODABLE);
    await put(cwd, ".claude/settings.json", '{"model": "x"}\n');

    const output = await stderrOf(() =>
      sync(options(cwd, { up: Infinity, create: true })),
    );

    assert.match(
      output,
      new RegExp(`warning: .*${bad.replace(/[.\\]/gu, "\\$&")}.*allow`, "u"),
    );
    assert.match(
      await readFile(join(cwd, ".claude", "settings.json"), "utf-8"),
      /Bash\(rm:\*\)/u,
    );
    assert.equal(await readFile(bad, "utf-8"), UNDECODABLE);
  });

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

  void it("skips an ancestor's file that is not valid UTF-8", async () => {
    const { parent, cwd } = await nested();
    await writeFile(
      join(parent, "opencode.json"),
      Buffer.from([0x7b, 0xe9, 0x7d]),
    );

    const output = await stderrOf(() =>
      sync(options(cwd, { up: Infinity, create: true })),
    );

    assert.match(output, /warning: .*opencode\.json.*not valid UTF-8/u);
  });

  void it("still stops for the same undecodable file in the directory it writes", async () => {
    const { cwd } = await nested();
    await put(cwd, ".claude/settings.json", UNDECODABLE);

    await assert.rejects(
      sync(options(cwd, { up: Infinity })),
      /settings\.json.*allow/u,
    );
  });
});

void describe("a warning about a source is reported once per change of that file", () => {
  void it("repeats only when the file's content changes", async () => {
    const { parent, cwd } = await nested();
    const bad = await put(parent, ".claude/settings.json", UNDECODABLE);
    const warned = new Map<string, string>();
    const run = (): Promise<string> =>
      stderrOf(() => sync(options(cwd, { up: Infinity, warned })));

    const first = await run();
    const second = await run();
    await writeFile(bad, JSON.stringify({ permissions: { allow: 7 } }));
    const third = await run();

    assert.match(first, /warning: .*settings\.json/u);
    assert.doesNotMatch(second, /warning: .*settings\.json/u);
    assert.match(third, /warning: .*settings\.json/u);
  });
});
