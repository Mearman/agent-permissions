import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sync, SYNC_OWNED_KEYS } from "../sync.ts";
import { AgentPermissionPolicy } from "../schema.ts";
import { cleanup, options, project, put } from "./native-config-fixture.ts";

after(cleanup);

/** A value for each canonical key sync does not own, laid out as a person would write it. */
const UNOWNED_SAMPLES: Record<string, string> = {
  $schema: '"https://example.com/schema.json"',
  ceiling: "true",
  with: '["claude-code", "opencode"]',
  without: '["codex"]',
  up: "3",
  sync: '{"mode": "watch",   "backup": true}',
};

void describe("the canonical file keeps every key sync does not own", () => {
  void it("has a sample for every schema key that is not owned, so a new key is covered", () => {
    const unowned = Object.keys(AgentPermissionPolicy.shape).filter(
      (key) => !SYNC_OWNED_KEYS.includes(key),
    );
    assert.deepEqual(unowned.sort(), Object.keys(UNOWNED_SAMPLES).sort());
  });

  void it("leaves each unowned key's text identical when the merge changes the rules", async () => {
    const cwd = await project({});
    const lines = Object.entries(UNOWNED_SAMPLES).map(
      ([key, value]) => `    "${key}":   ${value}`,
    );
    const original = `{\n${lines.join(",\n")},\n    "rules": []\n}\n`;
    await put(cwd, ".agents/permissions.json", original);
    await put(
      cwd,
      ".claude/settings.json",
      JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }),
    );

    await sync(options(cwd));

    const text = await readFile(
      join(cwd, ".agents", "permissions.json"),
      "utf-8",
    );
    for (const line of lines) assert.ok(text.includes(line), line);
    assert.match(text, /Bash/u);
  });

  void it("keeps the sync section the daemon reads at startup", async () => {
    const cwd = await project({});
    await put(
      cwd,
      ".agents/permissions.json",
      '{"sync": {"mode": "watch", "backup": true}}\n',
    );
    await put(
      cwd,
      ".claude/settings.json",
      JSON.stringify({ permissions: { allow: ["Read"] } }),
    );

    await sync(options(cwd));

    const written: unknown = JSON.parse(
      await readFile(join(cwd, ".agents", "permissions.json"), "utf-8"),
    );
    assert.deepEqual(
      typeof written === "object" && written !== null
        ? Object.fromEntries(Object.entries(written)).sync
        : undefined,
      { mode: "watch", backup: true },
    );
  });

  void it("does not refold the user's permissions lists when the merge did not change the rules", async () => {
    const cwd = await project({});
    const original =
      '{\n  "permissions": {\n    "allow": ["Read"],\n    "deny": ["Bash(rm:*)"]\n  }\n}\n';
    const path = await put(cwd, ".agents/permissions.json", original);
    await put(
      cwd,
      ".claude/settings.json",
      JSON.stringify({
        permissions: { allow: ["Read"], deny: ["Bash(rm:*)"], ask: [] },
      }),
    );

    await sync(options(cwd));

    assert.equal(await readFile(path, "utf-8"), original);
  });

  void it("refuses a canonical file in the working directory that is not valid JSON", async () => {
    const cwd = await project({});
    await writeFile(join(cwd, ".agents", "permissions.json"), "{ nope");
    await put(
      cwd,
      ".claude/settings.json",
      JSON.stringify({ permissions: { allow: ["Read"] } }),
    );

    await assert.rejects(sync(options(cwd)), /permissions\.json/u);
    assert.equal(
      await readFile(join(cwd, ".agents", "permissions.json"), "utf-8"),
      "{ nope",
    );
  });
});
