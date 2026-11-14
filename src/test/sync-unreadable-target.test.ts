import assert from "node:assert/strict";
import { chmod, readFile } from "node:fs/promises";
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

void describe("a target that cannot be read stops the sync before any write", () => {
  void it("refuses a file it is not allowed to read instead of treating it as new", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root can read any file");
      return;
    }
    const cwd = await project({ rules: [denyRm] });
    const text = JSON.stringify({ model: "opus", permissions: {} });
    const path = await put(cwd, ".claude/settings.json", text);
    await chmod(path, 0o200);

    await assert.rejects(sync(options(cwd)), /settings\.json: cannot be read/u);

    await chmod(path, 0o600);
    assert.equal(await readFile(path, "utf-8"), text);
  });
});
