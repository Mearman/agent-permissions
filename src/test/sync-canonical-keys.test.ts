import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { AgentPermissionPolicy } from "../schema.ts";
import { SYNC_OWNED_KEYS } from "../sync.ts";
import { cleanup } from "./native-config-fixture.ts";

after(cleanup);

/**
 * A value for each canonical key sync does not own, laid out as a person would write it. `with` and
 * `without` exclude each other in the schema, so they are exercised in separate files.
 */
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
});
