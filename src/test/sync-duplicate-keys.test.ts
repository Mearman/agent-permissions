import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sync, SyncRefusedError } from "../sync.ts";
import {
  cleanup,
  denyRm,
  options,
  project,
  put,
} from "./native-config-fixture.ts";

after(cleanup);

/** A file where the agent and the edit would disagree about which duplicate counts. */
async function refusedFor(
  text: string,
  canonical: Record<string, unknown>,
): Promise<{ error: SyncRefusedError; path: string; text: string }> {
  const cwd = await project(canonical);
  const path = await put(cwd, ".claude/settings.json", text);
  try {
    await sync(options(cwd, { create: true }));
  } catch (error) {
    assert.ok(error instanceof SyncRefusedError, String(error));
    assert.equal(await readFile(path, "utf-8"), text);
    return { error, path, text };
  }
  throw new assert.AssertionError({ message: "sync resolved" });
}

void describe("a duplicate key on an edited path is refused", () => {
  void it("when the object holding the permissions appears twice", async () => {
    const { error, path } = await refusedFor(
      '{"permissions":{"allow":["Read"]},"permissions":{"allow":["Read"]}}',
      { rules: [denyRm] },
    );

    assert.equal(error.path, path);
    assert.equal(error.reason, "duplicate-key");
    assert.match(error.message, /permissions/u);
  });

  void it("when the list being replaced appears twice", async () => {
    const { error } = await refusedFor(
      '{"permissions":{"deny":["Bash(a)"],"deny":["Bash(b)"]}}',
      { rules: [denyRm] },
    );

    assert.equal(error.reason, "duplicate-key");
    assert.match(error.message, /deny/u);
  });

  void it("when the list being removed appears twice", async () => {
    const { error } = await refusedFor(
      '{"permissions":{"allow":[],"allow":[]}}',
      {},
    );

    assert.equal(error.reason, "duplicate-key");
  });

  void it("but not when the duplicate is on a key sync does not edit", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = await put(
      cwd,
      ".claude/settings.json",
      '{"model": "a", "model": "b", "permissions": {}}\n',
    );

    await sync(options(cwd));

    const text = await readFile(path, "utf-8");
    assert.ok(text.startsWith('{"model": "a", "model": "b", '), text);
  });
});
