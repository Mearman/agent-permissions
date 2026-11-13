import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sync, SyncRefusedError } from "../sync.ts";
import {
  cleanup,
  denyRm,
  options,
  project,
  put,
} from "./native-config-fixture.ts";

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
  void it("for a config that is not valid JSON", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = await put(cwd, ".claude/settings.json", "{ nope");

    const error = await refusal(() => sync(options(cwd, { create: true })));

    assert.equal(error.path, path);
    assert.equal(error.reason, "invalid-format");
  });

  void it("for a config whose top level is not an object", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = await put(cwd, ".claude/settings.json", "[]");

    const error = await refusal(() => sync(options(cwd, { create: true })));

    assert.equal(error.path, path);
    assert.equal(error.reason, "not-an-object");
  });

  void it("for a value its codec cannot decode", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = await put(
      cwd,
      ".claude/settings.json",
      JSON.stringify({ permissions: { allow: "Read" } }),
    );

    const error = await refusal(() => sync(options(cwd)));

    assert.equal(error.path, path);
    assert.equal(error.reason, "undecodable");
  });

  void it("for a file that is not valid UTF-8", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = join(cwd, "opencode.json");
    await writeFile(path, Buffer.from([0x7b, 0xe9, 0x7d]));

    const error = await refusal(() => sync(options(cwd)));

    assert.equal(error.path, path);
    assert.equal(error.reason, "not-utf8");
  });

  void it("for a path that cannot be read", async () => {
    const cwd = await project({ rules: [denyRm] });
    await mkdir(join(cwd, ".claude", "settings.json"), { recursive: true });

    const error = await refusal(() => sync(options(cwd)));

    assert.equal(error.reason, "unreadable");
  });

  void it("for a link that points at nothing", async () => {
    const cwd = await project({ rules: [denyRm] });
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await symlink(join(cwd, "missing"), join(cwd, ".claude", "settings.json"));

    const error = await refusal(() => sync(options(cwd, { create: true })));

    assert.equal(error.reason, "dangling-link");
  });

  void it("for a canonical file that is not valid JSON", async () => {
    const cwd = await project({});
    await writeFile(join(cwd, ".agents", "permissions.json"), "{ nope");
    await put(
      cwd,
      ".claude/settings.json",
      '{"permissions": {"allow": ["Read"]}}',
    );

    const error = await refusal(() => sync(options(cwd)));

    assert.equal(error.reason, "invalid-format");
  });
});
