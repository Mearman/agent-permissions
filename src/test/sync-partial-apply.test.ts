import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sync, SyncWriteError } from "../sync.ts";
import { writeFileAtomic } from "../agent-files.ts";
import {
  cleanup,
  denyRm,
  options,
  project,
  put,
} from "./native-config-fixture.ts";

after(cleanup);

void describe("a failure part way through applying", () => {
  void it("names the failed file, never a temporary one, and says what was and was not written", async (t) => {
    if (process.getuid?.() === 0) {
      t.skip("root can write into a read-only directory");
      return;
    }
    const cwd = await project({ rules: [denyRm] });
    const settings = await put(
      cwd,
      ".claude/settings.json",
      '{"model": "x"}\n',
    );
    await put(cwd, "opencode.json", '{"permission": {"read": "allow"}}\n');
    await chmod(join(cwd, ".claude"), 0o500);
    let failure: unknown;
    try {
      await sync(options(cwd, { create: true }));
    } catch (error) {
      failure = error;
    } finally {
      await chmod(join(cwd, ".claude"), 0o700);
    }

    assert.ok(failure instanceof SyncWriteError);
    assert.doesNotMatch(failure.message, /\.tmp/u);
    assert.match(
      failure.message,
      new RegExp(
        `${settings.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}: could not be written`,
        "u",
      ),
    );
    assert.ok(failure.written.some((p) => p.endsWith("permissions.json")));
    assert.ok(failure.notWritten.includes(settings));
    assert.match(failure.message, /Written: .*permissions\.json/u);
    assert.match(failure.message, /Not written: .*settings\.json/u);
    assert.equal(await readFile(settings, "utf-8"), '{"model": "x"}\n');
  });

  void it("names the target, not the temporary file, when a bare write fails", async () => {
    const cwd = await project({});
    const path = await put(cwd, "a.json", "{}\n");

    await assert.rejects(
      writeFileAtomic(path, "{}\n", "{}\n", {
        renameFile: () =>
          Promise.reject(
            Object.assign(new Error("disk on fire"), { code: "EIO" }),
          ),
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith(`${path}: could not be written`) &&
        !error.message.includes(".tmp"),
    );
  });
});
