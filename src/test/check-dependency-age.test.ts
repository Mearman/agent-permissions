import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isRecord,
  packageVersionsFromLockfile,
  projectDocument,
  splitNameAndVersion,
} from "../../.github/scripts/check-dependency-age.ts";

// Two-document stream shaped like the real pnpm-lock.yaml: the self-management document (packageManagerDependencies, own packages map) comes first, the project document (importers with dependencies) second. Both have `packages:`, so identification has to key on importers, not on the packages map.
const LOCKFILE = `---
lockfileVersion: '9.0'

packages:

  pnpm@11.0.9:
    resolution: {integrity: sha512-x}

---
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      zod:
        specifier: ^4.4.3
        version: 4.4.3

packages:

  '@scope/pkg@1.0.0(peer@2.0.0)':
    resolution: {integrity: sha512-y}

  undici@7.29.0:
    resolution: {integrity: sha512-z}
`;

void describe("projectDocument", () => {
  void it("picks the document with importers['.'].dependencies, not the first packages map", () => {
    const doc = projectDocument(LOCKFILE);
    assert.ok(isRecord(doc.importers));
    assert.ok(!("packageManagerDependencies" in doc));
  });

  void it("throws when no document has a project importer", () => {
    assert.throws(
      () =>
        projectDocument("lockfileVersion: '9.0'\n\npackages:\n  a@1.0.0: {}\n"),
      /project importers/,
    );
  });
});

void describe("packageVersionsFromLockfile", () => {
  void it("strips peer-dependency suffixes from lockfile keys", () => {
    const entries = packageVersionsFromLockfile(LOCKFILE);
    assert.equal(entries.has("@scope/pkg@1.0.0"), true);
    assert.equal(entries.has("@scope/pkg@1.0.0(peer@2.0.0)"), false);
    assert.equal(entries.has("undici@7.29.0"), true);
    // The self-management document's pnpm entry must not leak into the project set.
    assert.equal(entries.has("pnpm@11.0.9"), false);
  });

  void it("throws when the project document has no packages map", () => {
    const noPackages =
      "---\nimporters:\n  '.':\n    dependencies:\n      zod: 4.4.3\n";
    assert.throws(() => packageVersionsFromLockfile(noPackages), /packages/);
  });
});

void describe("splitNameAndVersion", () => {
  void it("splits an unscoped name", () => {
    assert.deepEqual(splitNameAndVersion("undici@7.29.0"), {
      name: "undici",
      version: "7.29.0",
    });
  });

  void it("splits a scoped name on the last @, not the scope's", () => {
    assert.deepEqual(splitNameAndVersion("@scope/pkg@1.2.3"), {
      name: "@scope/pkg",
      version: "1.2.3",
    });
  });
});
