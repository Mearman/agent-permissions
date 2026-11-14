import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { opencodeCodec } from "../compat/codecs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OpenCode codec
// ---------------------------------------------------------------------------

void describe("opencodeCodec", () => {
  void describe("encode (canonical → OpenCode)", () => {
    void it("converts canonical rules to OpenCode granular format", () => {
      const encoded = z.encode(opencodeCodec, {
        rules: [
          { tool: "Bash", pattern: "git status *", tier: "allow" },
          { tool: "Read", tier: "allow" },
          { tool: "Bash", pattern: "rm *", tier: "deny" },
          { tool: "Edit", tier: "deny" },
          { tool: "Bash", pattern: "git push *", tier: "ask" },
        ],
      });
      assert.strictEqual(typeof encoded, "object");
      assert.ok(!Array.isArray(encoded));
      assert.ok("bash" in (encoded as Record<string, unknown>));
      assert.strictEqual(
        typeof (encoded as Record<string, unknown>).bash,
        "object",
      );
    });
  });
});
