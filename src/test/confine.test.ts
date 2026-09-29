/**
 * Confinement policies are judged by the evaluator itself: every assertion runs a real path through
 * `check` against the generated policy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { check } from "../api.ts";
import { confine } from "../confine.ts";
import { validate } from "../api.ts";

const FILE_TOOLS = ["Read", "Edit", "Write"];

function decide(policy: unknown, tool: string, path: string): string {
  return check(tool, path, policy).decision;
}

void describe("confine", () => {
  const policy = confine({ roots: ["/work/app"], cwd: "/work/app" });

  void it("produces a valid canonical policy", () => {
    assert.equal(validate(policy).valid, true);
  });

  void it("allows Read, Edit and Write on the root and everything under it", () => {
    for (const tool of FILE_TOOLS) {
      assert.equal(decide(policy, tool, "/work/app"), "allow");
      assert.equal(decide(policy, tool, "/work/app/src/index.ts"), "allow");
      assert.equal(
        decide(policy, tool.toLowerCase(), "/work/app/a/b/c"),
        "allow",
      );
    }
  });

  void it("does not allow a sibling that shares the root as a string prefix", () => {
    for (const tool of FILE_TOOLS) {
      assert.notEqual(decide(policy, tool, "/work/app-secrets/key"), "allow");
      assert.notEqual(decide(policy, tool, "/work/app-secrets"), "allow");
      assert.notEqual(decide(policy, tool, "/work/application"), "allow");
    }
  });

  void it("does not allow paths outside the roots", () => {
    for (const tool of FILE_TOOLS) {
      assert.notEqual(decide(policy, tool, "/etc/passwd"), "allow");
      assert.notEqual(decide(policy, tool, "/work"), "allow");
      assert.notEqual(decide(policy, tool, "/"), "allow");
    }
  });

  void it("denies traversal out of a root", () => {
    for (const tool of FILE_TOOLS) {
      assert.equal(decide(policy, tool, "/work/app/../secret"), "deny");
      assert.equal(decide(policy, tool, "/work/app/src/../../secret"), "deny");
      assert.equal(decide(policy, tool, "/work/app/.."), "deny");
      assert.equal(decide(policy, tool, "../secret"), "deny");
      assert.equal(decide(policy, tool, ".."), "deny");
    }
  });

  void it("allows dot-prefixed names that are not traversal", () => {
    assert.equal(decide(policy, "Read", "/work/app/..hidden/file"), "allow");
    assert.equal(decide(policy, "Read", "/work/app/a..b"), "allow");
  });

  void it("asks about outside paths by default", () => {
    assert.equal(policy.defaultMode, "restricted");
    assert.equal(decide(policy, "Read", "/etc/passwd"), "ask");
  });

  void it("denies outside paths when asked to", () => {
    const strict = confine({
      roots: ["/work/app"],
      cwd: "/work/app",
      outside: "deny",
    });
    assert.equal(strict.defaultMode, "readonly");
    assert.equal(decide(strict, "Read", "/etc/passwd"), "deny");
    assert.equal(decide(strict, "Edit", "/work/app-secrets/key"), "deny");
    assert.equal(decide(strict, "Edit", "/work/app/src/a.ts"), "allow");
  });

  void it("covers several roots and lists those other than the working directory", () => {
    const multi = confine({
      roots: ["/work/app", "/work/shared", "/work/app/"],
      cwd: "/work/app",
    });
    assert.deepEqual(multi.permissions?.additionalDirectories, [
      "/work/shared",
    ]);
    assert.equal(decide(multi, "Read", "/work/shared/lib.ts"), "allow");
    assert.equal(decide(multi, "Read", "/work/app/x"), "allow");
    assert.notEqual(decide(multi, "Read", "/work/shared-old/x"), "allow");
  });

  void it("leaves additionalDirectories out when every root is the working directory", () => {
    assert.equal(policy.permissions, undefined);
  });

  void it("normalises relative roots and dot segments against the working directory", () => {
    const rel = confine({
      roots: [".", "../shared/./lib"],
      cwd: "/work/app",
    });
    assert.deepEqual(rel.permissions?.additionalDirectories, [
      "/work/shared/lib",
    ]);
    assert.equal(decide(rel, "Read", "/work/app/a"), "allow");
    assert.equal(decide(rel, "Read", "/work/shared/lib/a"), "allow");
    assert.notEqual(decide(rel, "Read", "/work/shared/other"), "allow");
  });

  void it("confines the filesystem root without producing a double slash", () => {
    const all = confine({ roots: ["/"], cwd: "/work/app" });
    assert.equal(decide(all, "Read", "/etc/passwd"), "allow");
    assert.equal(decide(all, "Read", "/etc/../passwd"), "deny");
  });

  void it("treats glob characters in a root literally", () => {
    const odd = confine({ roots: ["/work/a*b"], cwd: "/work/a*b" });
    assert.equal(decide(odd, "Read", "/work/a*b/file"), "allow");
    assert.notEqual(decide(odd, "Read", "/work/aXb/file"), "allow");
    assert.notEqual(decide(odd, "Read", "/work/aXYb/file"), "allow");
  });

  void it("does not grant other tools", () => {
    assert.notEqual(decide(policy, "Bash", "cat /work/app/x"), "allow");
  });

  void it("requires at least one root", () => {
    assert.throws(() => confine({ roots: [], cwd: "/work/app" }), /root/);
  });
});
