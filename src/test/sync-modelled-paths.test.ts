import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sync } from "../sync.ts";
import {
  allowRead,
  cleanup,
  denyRm,
  json,
  options,
  project,
  put,
} from "./native-config-fixture.ts";

after(cleanup);

void describe("sync replaces only what it decoded", () => {
  void it("keeps Claude Code's other permissions keys, and the deny rule beside them", async () => {
    const cwd = await project({ rules: [allowRead] });
    await put(
      cwd,
      ".claude/settings.json",
      JSON.stringify({
        permissions: {
          deny: ["Bash(rm:*)"],
          disableBypassPermissionsMode: "disable",
        },
        model: "opus",
      }),
    );

    await sync(options(cwd, { create: true }));

    const settings = await json(join(cwd, ".claude", "settings.json"));
    assert.deepEqual(settings.permissions, {
      deny: ["Bash(rm:*)"],
      disableBypassPermissionsMode: "disable",
      allow: ["Read"],
      ask: [],
    });
    assert.equal(settings.model, "opus");
  });

  void it("keeps OpenCode's permission keys the codec does not map", async () => {
    const cwd = await project({ rules: [denyRm] });
    await put(
      cwd,
      "opencode.json",
      JSON.stringify({
        permission: { read: "allow", doom_loop: "deny", skill: { "*": "ask" } },
      }),
    );

    await sync(options(cwd));

    const config = await json(join(cwd, "opencode.json"));
    assert.deepEqual(config.permission, {
      read: "allow",
      doom_loop: "deny",
      skill: { "*": "ask" },
      bash: { "rm *": "deny" },
    });
  });

  void it("keeps a permission key from a newer OpenCode instead of failing to decode", async () => {
    const cwd = await project({ rules: [denyRm] });
    await put(
      cwd,
      "opencode.json",
      JSON.stringify({ permission: { read: "allow", future_tool: "deny" } }),
    );

    await sync(options(cwd));

    const config = await json(join(cwd, "opencode.json"));
    assert.deepEqual(config.permission, {
      read: "allow",
      future_tool: "deny",
      bash: { "rm *": "deny" },
    });
  });

  void it("keeps Kiro's behaviour flags and the settings of tools it does not model", async () => {
    const cwd = await project({ rules: [denyRm] });
    await put(
      cwd,
      ".kiro/permissions.json",
      JSON.stringify({
        toolsSettings: {
          shell: { autoAllowReadonly: true },
          aws: { autoAllowReadonly: true },
          code: { enabled: true },
        },
      }),
    );

    await sync(options(cwd));

    const config = await json(join(cwd, ".kiro", "permissions.json"));
    assert.deepEqual(config.toolsSettings, {
      shell: { autoAllowReadonly: true, deniedCommands: ["\\Arm:*\\z"] },
      aws: { autoAllowReadonly: true },
      code: { enabled: true },
    });
  });

  void it("removes a modelled path the encoding no longer writes, for Claude Code", async () => {
    const cwd = await project({});
    await put(
      cwd,
      ".claude/settings.json",
      JSON.stringify({ model: "opus", permissions: { allow: [], ask: [] } }),
    );

    await sync(options(cwd));

    const settings = await json(join(cwd, ".claude", "settings.json"));
    assert.deepEqual(settings.permissions, {});
    assert.equal(settings.model, "opus");
  });

  void it("removes a modelled path the encoding no longer writes, for OpenCode", async () => {
    const cwd = await project({ rules: [{ tool: "Glob", tier: "deny" }] });
    await put(
      cwd,
      "opencode.json",
      JSON.stringify({ permission: { bash: {}, doom_loop: "ask" } }),
    );

    await sync(options(cwd));

    const config = await json(join(cwd, "opencode.json"));
    assert.deepEqual(config.permission, { doom_loop: "ask", glob: "deny" });
  });

  void it("removes a modelled path the encoding no longer writes, for Kiro", async () => {
    const cwd = await project({ rules: [] });
    await put(
      cwd,
      ".kiro/permissions.json",
      JSON.stringify({
        toolsSettings: {
          shell: { denyByDefault: false, autoAllowReadonly: true },
        },
      }),
    );

    await sync(options(cwd));

    const config = await json(join(cwd, ".kiro", "permissions.json"));
    assert.deepEqual(config.toolsSettings, {
      shell: { autoAllowReadonly: true },
    });
  });

  void it("stops naming the file and key when a modelled key cannot be decoded, with or without create", async () => {
    for (const create of [false, true]) {
      const cwd = await project({ rules: [allowRead] });
      const text = JSON.stringify({
        model: "opus",
        permissions: { allow: "Read" },
      });
      const path = await put(cwd, ".claude/settings.json", text);

      await assert.rejects(
        sync(options(cwd, { create })),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("settings.json") &&
          error.message.includes("permissions"),
        `create: ${String(create)}`,
      );
      assert.equal(await readFile(path, "utf-8"), text);
    }
  });
});
