import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink } from "node:fs/promises";
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

void describe("a write is atomic and current", () => {
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
});
