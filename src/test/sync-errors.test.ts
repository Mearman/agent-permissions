import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { sync, SyncRefusedError } from "../sync.ts";
import { cleanup, denyRm, options, project } from "./native-config-fixture.ts";

after(cleanup);

/** The refusal a sync rejects with. */
async function refusal(run: () => Promise<unknown>): Promise<SyncRefusedError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof SyncRefusedError, String(error));
    return error;
  }
  throw new assert.AssertionError({ message: "sync resolved" });
}

void describe("sync rejects with a typed error that names the file and the reason", () => {
  void it("for a link that points at nothing", async () => {
    const cwd = await project({ rules: [denyRm] });
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await symlink(join(cwd, "missing"), join(cwd, ".claude", "settings.json"));

    const error = await refusal(() => sync(options(cwd, { create: true })));

    assert.equal(error.reason, "dangling-link");
  });
});
