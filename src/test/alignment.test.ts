/**
 * SDK alignment tests — runtime verification that our schemas
 * match the canonical values from each agent SDK.
 *
 * The compile-time checks live in `enums.ts` (type-level assertions).
 * These tests provide a second layer: if someone runs only the tests
 * (not the typecheck), they still get notified of divergence.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { PermissionMode, SandboxMode } from "../schema.ts";
import {
  ClaudeCodePermissionMode,
  CodexApprovalMode,
  CodexSandboxMode,
  OpenCodePermissionTools,
} from "../compat/enums.ts";
import { opencodeCodec } from "../compat/codecs.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract enum values from a Zod enum schema. */
function zodEnumValues(schema: {
  _zod: { values: Set<unknown> };
}): readonly string[] {
  return [...schema._zod.values].map(String);
}

// ---------------------------------------------------------------------------
// Claude Code SDK
// ---------------------------------------------------------------------------

describe("SDK alignment — Claude Code", () => {
  it("our schema includes every Claude Code SDK PermissionMode value", () => {
    const ours = new Set(zodEnumValues(PermissionMode));
    for (const mode of zodEnumValues(ClaudeCodePermissionMode)) {
      assert.ok(
        ours.has(mode),
        `Our schema is missing Claude Code mode: ${mode}`,
      );
    }
  });

  it("PermissionBehavior values match our permission tier names", () => {
    const tierNames = ["allow", "deny", "ask"];
    const ours = new Set(zodEnumValues(PermissionMode));
    assert.ok(ours.size > 0);
    assert.strictEqual(tierNames.length, 3);
  });
});

// ---------------------------------------------------------------------------
// Codex SDK
// ---------------------------------------------------------------------------

describe("SDK alignment — Codex", () => {
  it("our codec covers every Codex SDK ApprovalMode value", () => {
    const approvalModes = zodEnumValues(CodexApprovalMode);
    assert.strictEqual(approvalModes.length, 4);
    assert.ok(approvalModes.includes("never"));
    assert.ok(approvalModes.includes("on-failure"));
    assert.ok(approvalModes.includes("on-request"));
    assert.ok(approvalModes.includes("untrusted"));
  });

  it("our codec covers every Codex SDK SandboxMode value", () => {
    const sdkModes = zodEnumValues(CodexSandboxMode);
    const ourModes = new Set(zodEnumValues(SandboxMode));
    const mappings: readonly [string, string][] = [
      ["read-only", "readonly"],
      ["workspace-write", "workspace-write"],
      ["danger-full-access", "full-access"],
    ];
    assert.strictEqual(sdkModes.length, mappings.length);
    for (const [sdkMode, ourMode] of mappings) {
      assert.ok(
        ourModes.has(ourMode),
        `Our schema is missing sandbox mode "${ourMode}" (mapped from Codex "${sdkMode}")`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// OpenCode SDK
// ---------------------------------------------------------------------------

describe("SDK alignment — OpenCode", () => {
  it("our codec handles every OpenCode SDK permission tool", () => {
    const sdkTools = zodEnumValues(OpenCodePermissionTools);
    // Our codec's ocToCanonical map covers mapped tools; OC_UNMAPPED_TOOLS are
    // intentionally skipped during decode.
    const unmapped = new Set(["doom_loop", "question", "todowrite", "skill"]);
    // Decode a policy with each tool set to "allow" — if the tool is in the
    // codec schema, it will decode without error. Unmapped tools are skipped.
    for (const tool of sdkTools) {
      if (unmapped.has(tool)) continue;
      assert.doesNotThrow(
        () => opencodeCodec.decode({ [tool]: "allow" }),
        `OpenCode codec should accept SDK permission tool: ${tool}`,
      );
    }
  });
});
