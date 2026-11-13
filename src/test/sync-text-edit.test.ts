import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  /** An input around the owned block `"permissions": {"allow": ["Read"]}`, as before and after text. */
  const cases: [string, string, string][] = [
    [
      "two-space indent",
      '{\n  "model": "opus",\n  ',
      ',\n  "env": {"A": "1"}\n}\n',
    ],
    ["tabs", '{\n\t"model": "opus",\n\t', ',\n\t"env": {"A": "1"}\n}\n'],
    ["a compact file", '{"model":"opus",', ',"env":{"A":"1"}}'],
    [
      "CRLF line ends",
      '{\r\n  "model": "opus",\r\n  ',
      ',\r\n  "env": {}\r\n}\r\n',
    ],
    [
      "a number past double precision",
      '{"big": 12345678901234567890, "tiny": 1e-400, ',
      "}",
    ],
    ["integer-like keys in order", '{"z": 1, "2": "b", "1": "a", ', "}"],
    ["a duplicate key", '{"a": 1, "a": 2, ', "}"],
    ["a key named __proto__", '{"__proto__": {"x": 1}, ', "}"],
    [
      "trailing spaces and no final newline",
      '{"model": "opus",   \n  ',
      "  \n}",
    ],
    ["a number written with a trailing zero", '{"n": 1.0, "m": -0, ', "}"],
  ];

  for (const [label, before, after] of cases) {
    void it(`leaves ${label} untouched in .claude/settings.json`, async () => {
      const cwd = await project({ rules: [denyRm] });
      const path = await put(
        cwd,
        ".claude/settings.json",
        `${before}"permissions": {"allow": ["Read"]}${after}`,
      );

      await sync(options(cwd));

      const text = await readFile(path, "utf-8");
      assert.ok(text.startsWith(`${before}"permissions": {`), text);
      assert.ok(text.endsWith(`}${after}`), text);
      assert.ok(text.includes("Bash(rm:*)"), text);
    });
  }

  void it("keeps a byte order mark where it was", async () => {
    const cwd = await project({ rules: [denyRm] });
    const path = await put(
      cwd,
      ".claude/settings.json",
      '﻿{"model": "opus", "permissions": {}}\n',
    );

    await sync(options(cwd));

    const text = await readFile(path, "utf-8");
    assert.ok(text.startsWith('﻿{"model": "opus", "permissions": {'));
    assert.ok(text.includes("Bash(rm:*)"));
  });

  void it("refuses comments and trailing commas in .claude/settings.json, saying they are not valid there", async () => {
    for (const text of [
      '{\n  // my model\n  "model": "opus"\n}\n',
      '{"model": "opus",}\n',
    ]) {
      const cwd = await project({ rules: [denyRm] });
      const path = await put(cwd, ".claude/settings.json", text);

      await assert.rejects(
        sync(options(cwd, { create: true })),
        /comments and trailing commas are not valid/u,
      );
      assert.equal(await readFile(path, "utf-8"), text);
    }
  });

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

void describe("OpenCode's two config file names", () => {
  void it("edits opencode.jsonc, which OpenCode ranks above opencode.json, and warns that both apply", async () => {
    const cwd = await project({ rules: [denyRm] });
    const plain = await put(
      cwd,
      "opencode.json",
      '{"permission": {"read": "allow"}}\n',
    );
    const rich = await put(
      cwd,
      "opencode.jsonc",
      '{\n  // mine\n  "permission": {"edit": "ask"}\n}\n',
    );
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (data: string | Uint8Array): boolean => {
      chunks.push(String(data));
      return true;
    };
    try {
      await sync(options(cwd));
    } finally {
      process.stderr.write = original;
    }

    assert.equal(
      await readFile(plain, "utf-8"),
      '{"permission": {"read": "allow"}}\n',
    );
    const edited = await readFile(rich, "utf-8");
    assert.ok(edited.includes("// mine"));
    assert.match(edited, /"rm \*":\s*"deny"/u);
    assert.match(
      chunks.join(""),
      /opencode\.jsonc and .*opencode\.json both exist/u,
    );
  });
});
