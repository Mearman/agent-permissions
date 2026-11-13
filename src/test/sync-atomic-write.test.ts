import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
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

void describe("a write is atomic and current", () => {
  void it("replaces the file through a rename, leaving no temporary file and keeping its mode", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = await put(cwd, ".claude/settings.json", '{"model": "opus"}\n');
    await chmod(path, 0o640);
    const before = (await stat(path)).ino;

    await sync(options(cwd, { create: true }));

    // A rename puts a new file at the path; an in-place write would keep the inode.
    assert.notEqual((await stat(path)).ino, before);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.deepEqual(
      (await readdir(join(cwd, ".claude"))).filter((n) => n.endsWith(".tmp")),
      [],
    );
  });

  void it("writes through a symlink to the file it points at, keeping the link", async () => {
    const cwd = await project({ rules: [denyRm] });
    const real = await put(cwd, "shared/settings.json", '{"model": "opus"}\n');
    await mkdir(join(cwd, ".claude"), { recursive: true });
    const link = join(cwd, ".claude", "settings.json");
    await symlink(real, link);

    await sync(options(cwd, { create: true }));

    assert.equal((await stat(link)).isFile(), true);
    assert.match(await readFile(real, "utf-8"), /Bash\(rm:\*\)/u);
    assert.equal((await readFile(link, "utf-8")).includes("opus"), true);
  });

  void it("stops without writing when the file changed since the proposal", async () => {
    const cwd = await project({});
    const path = await put(cwd, "a.json", '{"a": 1}\n');

    await assert.rejects(
      writeFileAtomic(path, '{"a": 2}\n', '{"a": 0}\n'),
      /changed/u,
    );

    assert.equal(await readFile(path, "utf-8"), '{"a": 1}\n');
    assert.deepEqual(
      (await readdir(cwd)).filter((n) => n.endsWith(".tmp")),
      [],
    );
  });

  void it("stops when a file expected to be absent has appeared", async () => {
    const cwd = await project({});
    const path = await put(cwd, "a.json", "{}\n");

    await assert.rejects(writeFileAtomic(path, "{}\n", null), /changed/u);
  });
});
