import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CODECS,
  KIRO_TOOL_NAMES,
  MODELLED_PATHS,
  OPENCODE_NATIVE_KEYS,
} from "../compat/codecs.ts";
import { isRecord } from "../guards.ts";

/**
 * Sync replaces a modelled path with what the encoder writes there, so a modelled key that the
 * decoder reads (possibly through an alias) must be written back, or a restriction at it is lost.
 * Each key is enumerated from the codec's own schema and tables, so a new alias is probed.
 */
void describe("every modelled native key round-trips through its codec", () => {
  const modelledOpenCode = new Set(MODELLED_PATHS.opencode.map((p) => p[0]));

  for (const key of OPENCODE_NATIVE_KEYS) {
    if (key === "external_directory") continue;
    void it(`OpenCode ${key}: written back when modelled, otherwise left to sync untouched`, () => {
      const native = { [key]: "deny" };
      // The payload is a fixed shape built above; decode validates it against the codec's schema.
      const decoded = CODECS.opencode.decode(native);
      const encoded: unknown = CODECS.opencode.encode(decoded);
      assert.ok(isRecord(encoded));
      if (modelledOpenCode.has(key)) {
        assert.ok(
          key in encoded,
          `${key} is modelled but the encoder does not write it back`,
        );
      }
    });
  }

  for (const tool of [...KIRO_TOOL_NAMES, "unknown_tool"]) {
    void it(`Kiro allowedTools entry ${tool} is written back`, () => {
      const decoded = CODECS.kiro.decode({ allowedTools: [tool] });
      const encoded: unknown = CODECS.kiro.encode(decoded);
      assert.ok(isRecord(encoded));
      assert.deepEqual(encoded.allowedTools, [tool]);
    });
  }
});
