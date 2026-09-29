/** A profile that extends others states only what differs from them. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { codexCodec } from "../compat/codecs.ts";
import { resolveProfiles } from "../profiles.ts";
import { AgentPermissionPolicy } from "../schema.ts";

void describe("resolveProfiles", () => {
  void it("puts a parent's rules before the profile's own", () => {
    const resolved = resolveProfiles({
      base: { deny: ["Bash(sudo:*)"], allow: ["Read"] },
      dev: { extends: ["base"], allow: ["Bash(npm:*)"], deny: ["Bash(rm:*)"] },
    });
    assert.deepEqual(resolved.dev, {
      deny: ["Bash(sudo:*)", "Bash(rm:*)"],
      allow: ["Read", "Bash(npm:*)"],
    });
    assert.deepEqual(resolved.base, {
      deny: ["Bash(sudo:*)"],
      allow: ["Read"],
    });
  });

  void it("takes several parents in the order given, without repeats", () => {
    const resolved = resolveProfiles({
      a: { deny: ["Bash(a:*)"] },
      b: { extends: ["a"], deny: ["Bash(b:*)"] },
      c: { extends: ["a"], deny: ["Bash(c:*)"] },
      d: { extends: ["b", "c"], deny: ["Bash(d:*)"] },
    });
    assert.deepEqual(resolved.d?.deny, [
      "Bash(a:*)",
      "Bash(b:*)",
      "Bash(c:*)",
      "Bash(d:*)",
    ]);
  });

  void it("lets the profile's own default mode win over its parents'", () => {
    const resolved = resolveProfiles({
      base: { defaultMode: "restricted" },
      loose: { extends: ["base"], defaultMode: "autonomous" },
      inherit: { extends: ["base"] },
    });
    assert.equal(resolved.loose?.defaultMode, "autonomous");
    assert.equal(resolved.inherit?.defaultMode, "restricted");
  });

  void it("never returns the extends list", () => {
    const resolved = resolveProfiles({
      base: { deny: ["Bash(sudo:*)"] },
      dev: { extends: ["base"] },
    });
    assert.equal("extends" in (resolved.dev ?? {}), false);
  });

  void it("refuses a cycle and names it", () => {
    assert.throws(
      () => resolveProfiles({ a: { extends: ["b"] }, b: { extends: ["a"] } }),
      /a -> b -> a/,
    );
  });

  void it("refuses a parent that does not exist", () => {
    assert.throws(
      () => resolveProfiles({ dev: { extends: ["missing"] } }),
      /missing/,
    );
  });
});

void describe("extends in the schema", () => {
  void it("accepts a profile extending another", () => {
    assert.equal(
      AgentPermissionPolicy.safeParse({
        profiles: {
          base: { deny: ["Bash(sudo:*)"] },
          dev: { extends: ["base"] },
        },
      }).success,
      true,
    );
  });

  void it("rejects a parent that does not exist and a cycle", () => {
    for (const profiles of [
      { dev: { extends: ["missing"] } },
      { a: { extends: ["b"] }, b: { extends: ["a"] } },
      { a: { extends: ["a"] } },
    ]) {
      assert.equal(
        AgentPermissionPolicy.safeParse({ profiles }).success,
        false,
        JSON.stringify(profiles),
      );
    }
  });
});

void describe("extends in the Codex codec", () => {
  void it("gives an extending profile its parents' restrictions", () => {
    const encoded = codexCodec.encode({
      profiles: {
        base: { deny: ["Read(./secrets)"] },
        dev: { extends: ["base"], deny: ["WebFetch(domain:evil.com)"] },
      },
      activeProfile: "dev",
    });
    assert.deepEqual(encoded.permissions?.dev, {
      filesystem: { ":workspace_roots": { secrets: "deny" } },
      network: { domains: { "evil.com": "deny" } },
    });
  });
});
