/** Canonical path rules map to the location Codex actually protects, or are refused. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { codexCodec } from "../compat/codecs.ts";
import { UnsupportedCapabilityError } from "../compat/unsupported.ts";
import type { AgentPermissionPolicy, Rule } from "../schema.ts";

function defaultFilesystem(policy: AgentPermissionPolicy): unknown {
  return codexCodec.encode(policy).permissions?.default?.filesystem;
}

function refusedPatterns(rules: Rule[]): (string | undefined)[] {
  try {
    codexCodec.encode({ rules });
  } catch (e) {
    assert.ok(e instanceof UnsupportedCapabilityError, String(e));
    return e.unsupported.map((u) => u.rule.pattern);
  }
  throw new assert.AssertionError({ message: "expected the encode to throw" });
}

void describe("codex codec encodes path rules where Codex reads them", () => {
  void it("puts a ./ path under :workspace_roots, not at the filesystem root", () => {
    assert.deepEqual(
      defaultFilesystem({
        rules: [{ tool: "Read", pattern: "./secrets", tier: "deny" }],
      }),
      { ":workspace_roots": { secrets: "deny" } },
    );
  });

  void it("gives a denied write read access under :workspace_roots", () => {
    assert.deepEqual(
      defaultFilesystem({
        rules: [
          { tool: "Write", pattern: "./dist", tier: "deny" },
          { tool: "Edit", pattern: "./dist", tier: "deny" },
        ],
      }),
      { ":workspace_roots": { dist: "read" } },
    );
  });

  void it("keeps an absolute path as an absolute key", () => {
    assert.deepEqual(
      defaultFilesystem({
        rules: [{ tool: "Read", pattern: "/etc/passwd", tier: "deny" }],
      }),
      { "/etc/passwd": "deny" },
    );
  });

  void it("writes a trailing wildcard as the subtree Codex protects", () => {
    assert.deepEqual(
      defaultFilesystem({
        rules: [
          { tool: "Read", pattern: "./secrets/**", tier: "deny" },
          { tool: "Write", pattern: "./build/*", tier: "deny" },
          { tool: "Read", pattern: "/var/private/**", tier: "deny" },
        ],
      }),
      {
        ":workspace_roots": { secrets: "deny", build: "read" },
        "/var/private": "deny",
      },
    );
  });

  void it("writes the workspace itself as the . subpath", () => {
    assert.deepEqual(
      defaultFilesystem({
        rules: [{ tool: "Write", pattern: "./**", tier: "deny" }],
      }),
      { ":workspace_roots": { ".": "read" } },
    );
  });

  void it("never lets a nested path loosen a denied ancestor", () => {
    // Codex lets the more specific entry win, so a nested read would reopen a denied subtree.
    assert.deepEqual(
      defaultFilesystem({
        rules: [
          { tool: "Read", pattern: "./private/**", tier: "deny" },
          { tool: "Write", pattern: "./private/notes", tier: "deny" },
          { tool: "Write", pattern: "/srv/**", tier: "deny" },
          { tool: "Read", pattern: "/srv/keys", tier: "deny" },
          { tool: "Write", pattern: "/srv/keys/public", tier: "deny" },
        ],
      }),
      {
        ":workspace_roots": { private: "deny", "private/notes": "deny" },
        "/srv": "read",
        "/srv/keys": "deny",
        "/srv/keys/public": "deny",
      },
    );
  });

  void it("carries workspace paths into every named profile", () => {
    const encoded = codexCodec.encode({
      rules: [{ tool: "Read", pattern: "./secrets", tier: "deny" }],
      profiles: { dev: { deny: ["Write(./dist)"] } },
      activeProfile: "dev",
    });
    assert.deepEqual(encoded.permissions, {
      dev: {
        filesystem: { ":workspace_roots": { secrets: "deny", dist: "read" } },
      },
    });
  });
});

void describe("codex codec refuses paths Codex cannot express faithfully", () => {
  const cases: [string, string][] = [
    ["a wildcard before the last segment", "./**/*.env"],
    ["a wildcard inside a name", "./secrets/*.pem"],
    ["a home-relative path, which the policy does not expand", "~/.ssh"],
    ["a bare relative path", "secrets"],
    ["a path leaving the workspace", "./../shared"],
    ["a path with a . segment", "./a/./b"],
    ["an empty segment", "./a//b"],
    ["a character Codex reads as a glob", "./file[1]"],
    ["a ? Codex reads as a glob", "/tmp/a?b"],
    ["a literal asterisk", String.raw`./a\*b`],
    ["a string prefix", "./secret:*"],
  ];
  for (const [what, pattern] of cases) {
    void it(`refuses ${what}`, () => {
      assert.deepEqual(
        refusedPatterns([{ tool: "Read", pattern, tier: "deny" }]),
        [pattern],
      );
    });
  }
});

void describe("codex codec decodes Codex path entries", () => {
  void it("reads :workspace_roots subpaths as ./ paths and their subtrees", () => {
    const decoded = codexCodec.decode({
      permissions: {
        default: {
          filesystem: {
            ":workspace_roots": { ".": "write", secrets: "deny", docs: "read" },
          },
        },
      },
      default_permissions: "default",
    });
    assert.deepEqual(decoded.rules, [
      { tool: "Read", pattern: "./secrets", tier: "deny" },
      { tool: "Read", pattern: "./secrets/**", tier: "deny" },
      { tool: "Write", pattern: "./secrets", tier: "deny" },
      { tool: "Write", pattern: "./secrets/**", tier: "deny" },
      { tool: "Edit", pattern: "./secrets", tier: "deny" },
      { tool: "Edit", pattern: "./secrets/**", tier: "deny" },
      { tool: "Write", pattern: "./docs", tier: "deny" },
      { tool: "Write", pattern: "./docs/**", tier: "deny" },
      { tool: "Edit", pattern: "./docs", tier: "deny" },
      { tool: "Edit", pattern: "./docs/**", tier: "deny" },
    ]);
  });

  void it("keeps an absolute key absolute", () => {
    const decoded = codexCodec.decode({
      permissions: { default: { filesystem: { "/etc/config": "read" } } },
      default_permissions: "default",
    });
    assert.deepEqual(decoded.rules, [
      { tool: "Write", pattern: "/etc/config", tier: "deny" },
      { tool: "Write", pattern: "/etc/config/**", tier: "deny" },
      { tool: "Edit", pattern: "/etc/config", tier: "deny" },
      { tool: "Edit", pattern: "/etc/config/**", tier: "deny" },
    ]);
  });

  void it("reads the legacy none as deny", () => {
    const decoded = codexCodec.decode({
      permissions: { default: { filesystem: { "/secrets": "none" } } },
      default_permissions: "default",
    });
    assert.ok(
      decoded.rules?.some((r) => r.tool === "Read" && r.pattern === "/secrets"),
    );
  });

  void it("escapes a backslash so the path stays literal", () => {
    const decoded = codexCodec.decode({
      permissions: { default: { filesystem: { "/a\\b": "deny" } } },
      default_permissions: "default",
    });
    assert.equal(decoded.rules?.[0]?.pattern, "/a\\\\b");
  });

  void it("ignores a write grant it has no restriction to derive from", () => {
    const decoded = codexCodec.decode({
      permissions: {
        default: { filesystem: { ":root": "write", "~/code": "write" } },
      },
      default_permissions: "default",
    });
    assert.equal(decoded.rules, undefined);
  });

  for (const [what, filesystem] of [
    ["a home-relative restriction", { "~/.ssh": "deny" }],
    ["a special root restriction", { ":minimal": "read" }],
    ["a glob restriction", { "/tmp/*.env": "deny" }],
    [
      "a workspace glob restriction",
      { ":workspace_roots": { "**/*.env": "deny" } },
    ],
  ] as const) {
    void it(`fails on ${what} instead of guessing its location`, () => {
      assert.throws(() =>
        codexCodec.decode({
          permissions: { default: { filesystem } },
          default_permissions: "default",
        }),
      );
    });
  }

  void it("rejects a whole-profile access string, which Codex does not accept", () => {
    assert.throws(() =>
      codexCodec.decode({
        // @ts-expect-error Codex's filesystem is always a table
        permissions: { default: { filesystem: "read" } },
      }),
    );
  });

  void it("round-trips a workspace and an absolute entry unchanged", () => {
    const filesystem = {
      ":workspace_roots": { secrets: "deny", docs: "read" },
      "/etc/config": "read",
    } as const;
    const decoded = codexCodec.decode({
      permissions: { default: { filesystem } },
      default_permissions: "default",
    });
    assert.deepEqual(codexCodec.encode(decoded).permissions?.default, {
      filesystem,
    });
  });
});
