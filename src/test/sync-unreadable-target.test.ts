import assert from "node:assert/strict";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readIfPresent } from "../agent-files.ts";
import { sync, SyncRefusedError } from "../sync.ts";
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

void describe("the read seam", () => {
  const failing = (code: string) => (path: string) => {
    if (path.endsWith("settings.json")) {
      return Promise.reject(Object.assign(new Error("injected"), { code }));
    }
    return readFile(path);
  };

  void it("reads a file as before when none is injected", async () => {
    const cwd = await project({ rules: [denyRm] });
    assert.equal(await readIfPresent(join(cwd, "missing.json")), null);
  });

  void it("refuses a read that fails with the injected code, naming the file", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = await put(cwd, ".claude/settings.json", "{}");
    for (const code of ["EIO", "EMFILE"]) {
      await assert.rejects(
        readIfPresent(path, failing(code)),
        (error) =>
          error instanceof SyncRefusedError &&
          error.reason === "unreadable" &&
          error.path === path,
        code,
      );
    }
  });

  void it("is passed on by sync to every config read", async () => {
    const cwd = await project({ rules: [denyRm] });
    await put(cwd, ".claude/settings.json", "{}");
    await assert.rejects(
      sync({ ...options(cwd), readFile: failing("EIO") }),
      (error) =>
        error instanceof SyncRefusedError && error.reason === "unreadable",
    );
  });
});
