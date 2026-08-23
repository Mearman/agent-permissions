import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDocument } from "yaml";
import {
  classifyAdvisories,
  currentOverrides,
  inertOverrideKeys,
  isAuditAdvisory,
  isAuditReport,
  resolvedVersionsFromLockfileText,
  withOverrides,
  type AuditAdvisory,
} from "../../.github/scripts/audit-autofix.ts";

function advisory(overrides: Partial<AuditAdvisory> = {}): AuditAdvisory {
  return {
    module_name: "undici",
    vulnerable_versions: ">=7.0.0 <7.29.0",
    patched_versions: ">=7.29.0",
    severity: "high",
    github_advisory_id: "GHSA-test-test-test",
    title: "test advisory",
    url: "https://github.com/advisories/GHSA-test-test-test",
    ...overrides,
  };
}

void describe("audit report guards", () => {
  void it("accepts a well-formed advisory", () => {
    assert.equal(isAuditAdvisory(advisory()), true);
  });

  void it("rejects an advisory missing a field", () => {
    const withoutUrl: Record<string, unknown> = { ...advisory() };
    delete withoutUrl.url;
    assert.equal(isAuditAdvisory(withoutUrl), false);
  });

  void it("rejects a report whose advisories are not all well-formed", () => {
    assert.equal(
      isAuditReport({ advisories: { a: advisory(), b: 42 } }),
      false,
    );
    assert.equal(isAuditReport({ advisories: { a: advisory() } }), true);
  });
});

void describe("override bookkeeping", () => {
  void it("withOverrides adds an overrides map without disturbing the rest of the document", () => {
    const workspace = parseDocument('packages:\n  - "."\n');
    const next = withOverrides(workspace, { "undici@<7": ">=7" });
    assert.deepEqual(next.toJS(), {
      packages: ["."],
      overrides: { "undici@<7": ">=7" },
    });
    // The input document is not mutated.
    assert.deepEqual(workspace.toJS(), { packages: ["."] });
  });

  void it("withOverrides preserves comments elsewhere in the document", () => {
    const workspace = parseDocument(
      "# a load-bearing comment\nminimumReleaseAge: 10080\n",
    );
    const next = withOverrides(workspace, { a: "1" });
    assert.match(next.toString(), /# a load-bearing comment/);
    assert.match(next.toString(), /overrides:\n\s+a: "1"/);
  });

  void it("currentOverrides reads back only string-valued entries", () => {
    const workspace = parseDocument(
      "overrides:\n  keep: ^1.0.0\n  drop: 42\n  also: null\n",
    );
    assert.deepEqual(currentOverrides(workspace), { keep: "^1.0.0" });
    assert.deepEqual(currentOverrides(parseDocument("")), {});
  });
});

void describe("classifyAdvisories", () => {
  void it("defers pnpm self-audit findings rather than offering them as override candidates", () => {
    const { deferred, candidates } = classifyAdvisories([
      advisory({ module_name: "pnpm", patched_versions: ">=11.5.3" }),
    ]);
    assert.equal(candidates.length, 0);
    assert.equal(deferred.length, 1);
    const [first] = deferred;
    assert.ok(first, "expected a deferred entry");
    assert.match(first.reason, /packageManager/);
  });

  void it("defers advisories with no patched version", () => {
    const { deferred, candidates } = classifyAdvisories([
      advisory({ patched_versions: "<0.0.0" }),
      advisory({
        github_advisory_id: "GHSA-two-two-two",
        patched_versions: "",
      }),
    ]);
    assert.equal(candidates.length, 0);
    assert.equal(deferred.length, 2);
    assert.equal(
      deferred.every(
        (d) => d.reason === "no patched version exists upstream yet",
      ),
      true,
    );
  });

  void it("groups advisories sharing a module and vulnerable range under one candidate", () => {
    const first = advisory({ github_advisory_id: "GHSA-a" });
    const second = advisory({
      github_advisory_id: "GHSA-b",
      patched_versions: ">=7.30.0",
    });
    const { candidates, deferred } = classifyAdvisories([first, second]);
    assert.equal(candidates.length, 1);
    assert.equal(deferred.length, 0);
    const [candidate] = candidates;
    assert.ok(candidate, "expected exactly one grouped candidate");
    assert.equal(candidate.advisories.length, 2);
    // The later advisory's patched range wins, matching the existing append-and-overwrite behaviour.
    assert.equal(candidate.range, ">=7.30.0");
    assert.equal(candidate.overrideKey, "undici@>=7.0.0 <7.29.0");
  });

  void it("keeps distinct modules and distinct ranges as separate candidates", () => {
    const { candidates } = classifyAdvisories([
      advisory(),
      advisory({
        module_name: "fast-uri",
        github_advisory_id: "GHSA-c",
      }),
      advisory({
        github_advisory_id: "GHSA-d",
        vulnerable_versions: ">=7.30.0 <7.31.0",
        patched_versions: ">=7.31.0",
      }),
    ]);
    assert.equal(candidates.length, 3);
  });
});

void describe("override pruning", () => {
  const LOCKFILE = `---
lockfileVersion: '9.0'

packages:

  pnpm@11.0.9: {}

---
lockfileVersion: '9.0'

importers:

  '.':
    dependencies:
      zod: 4.4.3

packages:

  undici@6.28.0:
    resolution: {integrity: sha512-x}

  undici@7.29.0:
    resolution: {integrity: sha512-y}

  '@scope/pkg@1.0.0(peer@2.0.0)':
    resolution: {integrity: sha512-z}
`;

  void it("resolves the project document's package versions, peer suffixes stripped", () => {
    const resolved = resolvedVersionsFromLockfileText(LOCKFILE);
    assert.deepEqual(resolved.get("undici"), new Set(["6.28.0", "7.29.0"]));
    assert.deepEqual(resolved.get("@scope/pkg"), new Set(["1.0.0"]));
    assert.equal(resolved.has("pnpm"), false);
  });

  void it("flags overrides whose selector matches no resolved version, ignoring out-of-selector resolutions", () => {
    const resolved = resolvedVersionsFromLockfileText(LOCKFILE);
    const inert = inertOverrideKeys(
      {
        // no resolved undici is <6.27.0, so the selector can never rewrite anything -- inert
        "undici@<6.27.0": ">=6.27.0",
        // 6.28.0 matches the selector >=7.0.0 <7.29.0? no -- but 7.25.0-style logic aside, 6.28.0 is outside it and 7.29.0 is outside it too (range excludes 7.29.0), so nothing matches -- inert
        "undici@>=7.0.0 <7.29.0": ">=7.29.0",
        // a selector that DOES match 7.29.0 would be load-bearing; this one does not
        "undici@>=8.0.0": ">=8.1.0",
        // package absent from the lockfile -- kept (nothing proves it will not return)
        "ghost@<2.0.0": ">=2.0.0",
        // bare selector-less key -- never provably inert, kept
        undici2: ">=1.0.0",
      },
      resolved,
    );
    assert.deepEqual(inert, [
      "undici@<6.27.0",
      "undici@>=7.0.0 <7.29.0",
      "undici@>=8.0.0",
    ]);
  });
});
