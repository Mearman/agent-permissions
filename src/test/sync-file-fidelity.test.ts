import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { sync } from "../sync.ts";
import { writeFileAtomic } from "../agent-files.ts";
import {
  cleanup,
  denyRm,
  options,
  project,
  put,
} from "./native-config-fixture.ts";

after(cleanup);

/** Names of leftover temporary files in a directory. */
async function temporaries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith(".tmp"));
}

void describe("a backup is a faithful copy of its source", () => {
  void it("has the source's mode and holds its exact bytes", async () => {
    const cwd = await project({ rules: [denyRm] });
    const original = '{"env": {"TOKEN": "secret"}, "permissions": {}}\n';
    const path = await put(cwd, ".claude/settings.json", original);
    await chmod(path, 0o600);

    await sync(options(cwd, { backup: true }));

    const backup = join(cwd, ".claude", "settings.json.bak");
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    assert.equal(await readFile(backup, "utf-8"), original);
    assert.deepEqual(await temporaries(join(cwd, ".claude")), []);
  });
});

void describe("a file is read as bytes", () => {
  void it("refuses a target that is not valid UTF-8, naming it and saying so, and leaves it alone", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = join(cwd, "opencode.json");
    const bytes = Buffer.concat([
      Buffer.from("{\n  // caf"),
      Buffer.from([0xe9]),
      Buffer.from('\n  "permission": {}\n}\n'),
    ]);
    await writeFile(path, bytes);

    await assert.rejects(
      sync(options(cwd)),
      /opencode\.json: .*not valid UTF-8/u,
    );

    assert.deepEqual(await readFile(path), bytes);
  });
});

void describe("the temporary file", () => {
  void it("is never created with a wider mode than the file it replaces", async () => {
    const cwd = await project({});
    const path = await put(cwd, "secret.json", "{}\n");
    await chmod(path, 0o600);
    const previous = process.umask(0);
    try {
      const modes = new Set<number>();
      const state = { finished: false };
      const write = writeFileAtomic(
        path,
        "x".repeat(64 * 1024 * 1024),
        "{}\n",
      ).finally(() => {
        state.finished = true;
      });
      while (!state.finished) {
        for (const name of await temporaries(cwd)) {
          try {
            modes.add((await stat(join(cwd, name))).mode & 0o777);
          } catch {
            // The file was renamed away between the listing and the stat.
          }
        }
      }
      await write;
      assert.ok(modes.size > 0, "the temporary file was observed");
      assert.deepEqual([...modes], [0o600]);
    } finally {
      process.umask(previous);
    }
  });

  void it("is removed when the rename fails", async () => {
    const cwd = await project({});
    const path = await put(cwd, "a.json", "{}\n");

    await assert.rejects(
      writeFileAtomic(path, "{}\n", "{}\n", {
        renameFile: () =>
          Promise.reject(Object.assign(new Error("boom"), { code: "EIO" })),
      }),
      /boom/u,
    );

    assert.deepEqual(await temporaries(cwd), []);
    assert.equal(await readFile(path, "utf-8"), "{}\n");
  });
});

void describe("a file that cannot be replaced by a rename", () => {
  void it("is written in place when the rename reports it busy or on another device", async () => {
    for (const code of ["EBUSY", "EXDEV"]) {
      const cwd = await project({});
      const path = await put(cwd, "a.json", '{"a": 1}\n');

      await writeFileAtomic(path, '{"a": 2}\n', '{"a": 1}\n', {
        renameFile: () =>
          Promise.reject(Object.assign(new Error(code), { code })),
      });

      assert.equal(await readFile(path, "utf-8"), '{"a": 2}\n', code);
      assert.deepEqual(await temporaries(cwd), [], code);
    }
  });

  void it("is written in place when it is hard linked, so the other name sees the change", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = await put(cwd, ".claude/settings.json", '{"model": "opus"}\n');
    const other = join(cwd, "other-name.json");
    await link(path, other);

    await sync(options(cwd, { create: true }));

    assert.match(await readFile(other, "utf-8"), /Bash\(rm:\*\)/u);
    assert.equal((await stat(path)).ino, (await stat(other)).ino);
  });
});

void describe("a symbolic link at the path", () => {
  void it("is refused when it points at nothing, and stays a link", async () => {
    const cwd = await project({ rules: [denyRm] });
    await mkdir(join(cwd, ".claude"), { recursive: true });
    const linkPath = join(cwd, ".claude", "settings.json");
    await symlink(join(cwd, "missing.json"), linkPath);

    await assert.rejects(
      sync(options(cwd, { create: true })),
      /settings\.json: .*link.*does not exist/u,
    );

    assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  });
});
