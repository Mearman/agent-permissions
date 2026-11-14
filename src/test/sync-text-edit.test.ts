import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

void describe("bytes outside the owned keys survive an edit", () => {
  void it("edits opencode.jsonc in place, keeping its comments, and never creates opencode.json beside it", async () => {
    const cwd = await project({ rules: [denyRm] });
    const text =
      '{\n  // my editor settings\n  "model": "x", /* inline */\n  "permission": {\n    "read": "allow",\n  },\n}\n';
    const path = await put(cwd, "opencode.jsonc", text);

    await sync(options(cwd, { create: true }));

    const edited = await readFile(path, "utf-8");
    assert.ok(
      edited.startsWith(
        '{\n  // my editor settings\n  "model": "x", /* inline */\n',
      ),
    );
    assert.match(edited, /"rm \*": "deny"/u);
    assert.equal(existsSync(join(cwd, "opencode.json")), false);
  });

  void it("accepts comments in opencode.json", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = await put(
      cwd,
      "opencode.json",
      '{\n  // keep me\n  "permission": { "read": "allow" }\n}\n',
    );

    await sync(options(cwd));

    const edited = await readFile(path, "utf-8");
    assert.ok(edited.includes("// keep me"));
    assert.match(edited, /"rm \*":\s*"deny"/u);
  });
});
