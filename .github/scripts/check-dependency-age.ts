import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";

const MINIMUM_AGE_DAYS = 7;
const MINIMUM_AGE_MS = MINIMUM_AGE_DAYS * 24 * 60 * 60 * 1000;

export interface PackageVersion {
  name: string;
  version: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// pnpm-lock.yaml is a multi-document YAML stream when the project pins its own pnpm binary via packageManagerDependencies: one document for that self-management lockfile, one for the actual project dependencies. Both have their own `packages:` map, so the project document must be identified by its `importers['.'].dependencies` / `devDependencies`, not just picked as "the packages section".
export function projectDocument(yamlText: string): Record<string, unknown> {
  const docs = parseAllDocuments(yamlText).map((d) => {
    // toJS() is typed `any` in the yaml package; park it in an explicitly unknown-typed binding so nothing downstream inherits the any.
    const js: unknown = d.toJS();
    return js;
  });
  const projectDoc = docs.find((d): d is Record<string, unknown> => {
    if (!isRecord(d) || !isRecord(d.importers)) return false;
    const root = d.importers["."];
    return (
      isRecord(root) && ("dependencies" in root || "devDependencies" in root)
    );
  });
  if (!projectDoc) {
    throw new Error(
      "pnpm-lock.yaml had no document with a project importers['.'] entry",
    );
  }
  return projectDoc;
}

export function packageVersionsFromLockfile(yamlText: string): Set<string> {
  const doc = projectDocument(yamlText);
  if (!isRecord(doc.packages)) {
    throw new Error(
      "pnpm-lock.yaml's project document did not have a `packages` map",
    );
  }
  const entries = new Set<string>();
  for (const key of Object.keys(doc.packages)) {
    entries.add(key.replace(/(\([^)]*\))+$/, ""));
  }
  return entries;
}

export function splitNameAndVersion(nameAtVersion: string): PackageVersion {
  const at = nameAtVersion.lastIndexOf("@");
  return {
    name: nameAtVersion.slice(0, at),
    version: nameAtVersion.slice(at + 1),
  };
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function publishedAt(name: string, version: string): Date {
  let raw: string;
  try {
    raw = execFileSync("pnpm", ["info", name, "time", "--json"], {
      encoding: "utf8",
    });
  } catch (error) {
    throw new Error(`pnpm info ${name} time --json failed: ${String(error)}`, {
      cause: error,
    });
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed[version] !== "string") {
    throw new Error(
      `pnpm info ${name} time --json had no timestamp for version ${version}`,
    );
  }
  return new Date(parsed[version]);
}

// Exit codes are load-bearing for the caller (dependabot-auto-merge.yml): 1 means "a genuinely too-new package, skip this PR until it ages out" (routine, expected); 2 means "this script itself failed for an unrelated reason" (git/registry error, bad data) and must surface distinctly so a real problem doesn't get silently misreported as a grace period wait forever.
function failUnexpected(message: string): never {
  console.log(`::error::${message}`);
  process.exit(2);
}

// Wrapped in a main guard so the pure helpers above stay importable from the test suite: node executes this file directly for real runs, and the unit tests import the helpers without triggering any git or registry activity.
function main(): void {
  const prNumber = process.argv[2];
  if (!prNumber) {
    failUnexpected("usage: check-dependency-age.ts <PR_NUMBER>");
  }

  try {
    // Fetch main and the PR head explicitly rather than trusting the ambient checkout's HEAD/origin state — what HEAD points at differs by trigger (schedule/workflow_dispatch check out main directly; a pull_request trigger checks out a merge-preview ref instead). Forced (`+`) because a shallow `--depth 1` fetch grafts the new commit with no recorded parent, so a later re-fetch into the same local ref name is rejected as non-fast-forward even when main has only moved forward — this script runs once per PR in a loop that shares one checkout, and an earlier PR merging mid-loop advances main between invocations.
    const mainRef = "refs/remotes/origin/base-main";
    const prRef = `refs/remotes/origin/pr-${prNumber}`;
    git(["fetch", "--depth", "1", "origin", `+main:${mainRef}`]);
    git(["fetch", "--depth", "1", "origin", `+pull/${prNumber}/head:${prRef}`]);

    const baseLockfile = git(["show", `${mainRef}:pnpm-lock.yaml`]);
    const headLockfile = git(["show", `${prRef}:pnpm-lock.yaml`]);

    const basePackages = packageVersionsFromLockfile(baseLockfile);
    const headPackages = packageVersionsFromLockfile(headLockfile);

    const introduced = [...headPackages]
      .filter((entry) => !basePackages.has(entry))
      .map(splitNameAndVersion);

    if (introduced.length === 0) {
      console.log(
        `PR #${prNumber} introduces no new package versions in pnpm-lock.yaml — nothing to age-check.`,
      );
      process.exit(0);
    }

    const now = Date.now();
    const tooNew = introduced
      .map((pkg) => ({ pkg, publishedAt: publishedAt(pkg.name, pkg.version) }))
      .filter(
        ({ publishedAt }) => now - publishedAt.getTime() < MINIMUM_AGE_MS,
      );

    if (tooNew.length > 0) {
      for (const { pkg, publishedAt } of tooNew) {
        const ageDays = (
          (now - publishedAt.getTime()) /
          (24 * 60 * 60 * 1000)
        ).toFixed(1);
        console.log(
          `PR #${prNumber}: ${pkg.name}@${pkg.version} was published ${ageDays} days ago — waiting for the ${String(MINIMUM_AGE_DAYS)}-day grace period.`,
        );
      }
      process.exit(1);
    }

    console.log(
      `PR #${prNumber}: all ${String(introduced.length)} newly introduced package version(s) are at least ${String(MINIMUM_AGE_DAYS)} days old.`,
    );
  } catch (error) {
    failUnexpected(
      `dependency age check crashed for PR #${prNumber}: ${String(error)}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
