import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";

interface AuditAdvisory {
  module_name: string;
  vulnerable_versions: string;
  patched_versions: string;
  severity: string;
  github_advisory_id: string;
  title: string;
  url: string;
}

interface AuditReport {
  advisories: Record<string, AuditAdvisory>;
}

interface Candidate {
  advisories: AuditAdvisory[];
  overrideKey: string;
  range: string;
}

// pnpm 11.0.9 only honours override selectors written to package.json's `pnpm.overrides` field on a non-workspace project — an equivalent `overrides:` key in pnpm-workspace.yaml is silently ignored (confirmed empirically). Also confirmed empirically: adding a new override for a package that already has a resolved lockfile entry does NOT get applied by an incremental `pnpm install`, even with `--force` or `pnpm dedupe` — only deleting pnpm-lock.yaml and letting pnpm regenerate it from scratch reliably re-resolves against the new override. minimumReleaseAge still gates that fresh resolution, so this doesn't reopen the grace period for the packages actually being fixed; it does mean every other dependency can also drift to a newer in-range, aged version on a fix run, which `check` and `test` still gate as usual afterwards.
const PACKAGE_FILE = "package.json";
const LOCKFILE = "pnpm-lock.yaml";
const auditLevel = process.env.AUDIT_LEVEL ?? "high";

// pnpm audits its own pinned binary (module_name "pnpm") alongside the npm dependency graph. That finding isn't fixable via `overrides` — overrides only steer node_modules resolution, not which pnpm binary CI invokes — so it always goes straight to deferred.
const NOT_OVERRIDABLE = new Set(["pnpm"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuditAdvisory(value: unknown): value is AuditAdvisory {
  if (!isRecord(value)) return false;
  return (
    typeof value.module_name === "string" &&
    typeof value.vulnerable_versions === "string" &&
    typeof value.patched_versions === "string" &&
    typeof value.severity === "string" &&
    typeof value.github_advisory_id === "string" &&
    typeof value.title === "string" &&
    typeof value.url === "string"
  );
}

function isAuditReport(value: unknown): value is AuditReport {
  if (!isRecord(value)) return false;
  if (!("advisories" in value) || !isRecord(value.advisories)) return false;
  return Object.values(value.advisories).every(isAuditAdvisory);
}

function runAudit(): AuditReport {
  const result = spawnSync(
    "pnpm",
    ["audit", "--audit-level", auditLevel, "--json"],
    { encoding: "utf8" },
  );
  if (!result.stdout) {
    throw new Error(
      `pnpm audit produced no stdout (spawn error: ${String(result.error)}, stderr: ${result.stderr})`,
    );
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isAuditReport(parsed)) {
    throw new Error(
      "pnpm audit --json output did not match the expected shape",
    );
  }
  return parsed;
}

function readPackageJson(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(PACKAGE_FILE, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`${PACKAGE_FILE} did not parse to an object`);
  }
  return parsed;
}

function writePackageJson(doc: Record<string, unknown>): void {
  writeFileSync(PACKAGE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
}

function withOverrides(
  pkg: Record<string, unknown>,
  overrides: Record<string, string>,
): Record<string, unknown> {
  const pnpmField = isRecord(pkg.pnpm) ? pkg.pnpm : {};
  return { ...pkg, pnpm: { ...pnpmField, overrides } };
}

function currentOverrides(
  pkg: Record<string, unknown>,
): Record<string, string> {
  const pnpmField = isRecord(pkg.pnpm) ? pkg.pnpm : {};
  const overrides = isRecord(pnpmField.overrides) ? pnpmField.overrides : {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function freshInstall(): boolean {
  // Deleting only the lockfile isn't enough — confirmed empirically that pnpm still leaves an already-linked node_modules resolution alone in that case, silently ignoring the very override this script just added. Removing node_modules too forces genuine full re-resolution; pnpm's content-addressable store keeps this fast.
  rmSync(LOCKFILE, { force: true });
  rmSync("node_modules", { force: true, recursive: true });
  return spawnSync("pnpm", ["install"], { encoding: "utf8" }).status === 0;
}

function restoreFromGit(): void {
  spawnSync("git", ["checkout", "--", LOCKFILE, PACKAGE_FILE], {
    encoding: "utf8",
  });
  // freshInstall() deletes node_modules before every attempt; a plain `git checkout` only restores the two tracked files, so reinstall to leave a working environment behind for whatever runs next (the final re-audit below, or any later step in this same job).
  spawnSync("pnpm", ["install", "--frozen-lockfile"], { encoding: "utf8" });
}

function setOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  appendFileSync(outputFile, `${name}=${value}\n`);
}

function appendSummary(markdown: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  appendFileSync(summaryFile, markdown);
}

function fail(message: string): never {
  restoreFromGit();
  console.log(`::error::${message}`);
  process.exit(1);
}

function tryInstallWith(
  pkgBefore: Record<string, unknown>,
  baseOverrides: Record<string, string>,
  batch: Candidate[],
): boolean {
  const overrides = { ...baseOverrides };
  for (const c of batch) overrides[c.overrideKey] = c.range;
  writePackageJson(withOverrides(pkgBefore, overrides));
  return freshInstall();
}

// A single candidate that can never install (its patched range has no version clearing minimumReleaseAge yet, or it conflicts with peers) must not sink every other, independently-fixable candidate in the same batch. Bisect on failure; if two halves that each install fine independently still fail combined (a genuine cross-candidate conflict), fall back to a linear greedy pass, which always terminates with a verified-working subset.
function resolveMaximalSubset(
  pkgBefore: Record<string, unknown>,
  baseOverrides: Record<string, string>,
  batch: Candidate[],
): Candidate[] {
  if (batch.length === 0) return [];
  if (tryInstallWith(pkgBefore, baseOverrides, batch)) return batch;
  if (batch.length === 1) return [];

  const mid = Math.floor(batch.length / 2);
  const leftOk = resolveMaximalSubset(
    pkgBefore,
    baseOverrides,
    batch.slice(0, mid),
  );
  const rightOk = resolveMaximalSubset(
    pkgBefore,
    baseOverrides,
    batch.slice(mid),
  );
  const combined = [...leftOk, ...rightOk];
  if (combined.length === 0) return [];
  if (tryInstallWith(pkgBefore, baseOverrides, combined)) return combined;

  return greedyResolve(pkgBefore, baseOverrides, combined);
}

function greedyResolve(
  pkgBefore: Record<string, unknown>,
  baseOverrides: Record<string, string>,
  batch: Candidate[],
): Candidate[] {
  const working: Candidate[] = [];
  for (const c of batch) {
    const attempt = [...working, c];
    if (tryInstallWith(pkgBefore, baseOverrides, attempt)) {
      working.push(c);
    }
  }
  return working;
}

const initial = runAudit();
const advisories = Object.values(initial.advisories);
const initialIds = new Set(advisories.map((a) => a.github_advisory_id));

const deferred: { advisory: AuditAdvisory; reason: string }[] = [];
const candidatesByKey = new Map<string, Candidate>();

for (const advisory of advisories) {
  const overrideKey = `${advisory.module_name}@${advisory.vulnerable_versions}`;

  if (NOT_OVERRIDABLE.has(advisory.module_name)) {
    deferred.push({
      advisory,
      reason:
        "pnpm self-audit finding — requires bumping the packageManager field, not a dependency override",
    });
    continue;
  }

  if (!advisory.patched_versions || advisory.patched_versions === "<0.0.0") {
    deferred.push({
      advisory,
      reason: "no patched version exists upstream yet",
    });
    continue;
  }

  // Two distinct advisories can share the exact same module_name + vulnerable_versions (hence the same override selector) with different patched_versions — group them under one override attempt rather than silently dropping the second, so every advisory still gets a fixed/deferred outcome and a line in the summary.
  const existing = candidatesByKey.get(overrideKey);
  if (existing) {
    existing.advisories.push(advisory);
    existing.range = advisory.patched_versions;
  } else {
    candidatesByKey.set(overrideKey, {
      advisories: [advisory],
      overrideKey,
      range: advisory.patched_versions,
    });
  }
}

const candidates = [...candidatesByKey.values()];
let fixed: Candidate[] = [];

if (candidates.length > 0) {
  const pkgBefore = readPackageJson();
  const baseOverrides = currentOverrides(pkgBefore);

  fixed = resolveMaximalSubset(pkgBefore, baseOverrides, candidates);
  const notFixed = candidates.filter((c) => !fixed.includes(c));

  // resolveMaximalSubset's own recursion can leave the working tree reflecting a failed attempt (greedyResolve doesn't roll back after a rejected candidate) rather than the `fixed` set it settles on, so land on a known-clean final state explicitly: an exact reinstall of the verified set when something worked, or a plain git revert when nothing did — a fresh install with zero overrides isn't guaranteed byte-identical to the committed lockfile even though it should behave the same.
  if (fixed.length > 0) {
    if (!tryInstallWith(pkgBefore, baseOverrides, fixed)) {
      fail(
        "Could not reproduce the verified-working override set on the final install pass",
      );
    }
  } else {
    restoreFromGit();
  }

  const afterFix = runAudit();
  const stillPresent = new Set(
    Object.values(afterFix.advisories).map((a) => a.github_advisory_id),
  );

  for (const c of fixed) {
    for (const advisory of c.advisories) {
      if (stillPresent.has(advisory.github_advisory_id)) {
        fail(
          `${advisory.github_advisory_id} (${advisory.module_name}) was overridden but still appears in the post-fix audit`,
        );
      }
    }
  }

  for (const c of notFixed) {
    for (const advisory of c.advisories) {
      deferred.push({
        advisory,
        reason:
          "no version satisfies both the patched range and the 7-day minimumReleaseAge window yet (or a resolution conflict)",
      });
    }
  }
}

// Anything at or above the audit level that wasn't present before this run's changes is a brand-new problem introduced by an override or by the incidental full re-resolution in freshInstall() — never ship that silently just because the advisories we set out to fix are gone.
const final = runAudit();
const newlyIntroduced = Object.values(final.advisories).filter(
  (a) => !initialIds.has(a.github_advisory_id),
);
if (newlyIntroduced.length > 0) {
  fail(
    `The fix introduced new advisories not present before this run: ${newlyIntroduced.map((a) => `${a.github_advisory_id} (${a.module_name})`).join(", ")}`,
  );
}

if (deferred.length > 0) {
  const lines = deferred.map(
    (d) =>
      `::warning::${d.advisory.github_advisory_id} (${d.advisory.module_name}, ${d.advisory.severity}) not auto-fixed: ${d.reason} — ${d.advisory.url}`,
  );
  console.log(lines.join("\n"));
  appendSummary(
    `\n### Deferred audit findings\n\n| Advisory | Package | Severity | Reason |\n|---|---|---|---|\n${deferred
      .map(
        (d) =>
          `| [${d.advisory.github_advisory_id}](${d.advisory.url}) | ${d.advisory.module_name} | ${d.advisory.severity} | ${d.reason} |`,
      )
      .join("\n")}\n`,
  );
}

const fixedAdvisories = fixed.flatMap((c) =>
  c.advisories.map((advisory) => ({
    advisory,
    overrideKey: c.overrideKey,
    range: c.range,
  })),
);

if (fixedAdvisories.length > 0) {
  appendSummary(
    `\n### Auto-fixed audit findings\n\n| Advisory | Package | Patched range applied |\n|---|---|---|\n${fixedAdvisories
      .map(
        (f) =>
          `| [${f.advisory.github_advisory_id}](${f.advisory.url}) | ${f.advisory.module_name} | ${f.range} |`,
      )
      .join("\n")}\n`,
  );
  writeFileSync(
    "/tmp/audit-fix-commit-body.txt",
    fixedAdvisories
      .map(
        (f) =>
          `- ${f.advisory.module_name} (${f.overrideKey}) -> ${f.range}: ${f.advisory.github_advisory_id} ${f.advisory.url}`,
      )
      .join("\n"),
  );
}

setOutput("fixed", fixedAdvisories.length > 0 ? "true" : "false");

console.log(
  `Audit complete: ${String(fixedAdvisories.length)} fixed, ${String(deferred.length)} deferred (non-blocking).`,
);
