import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

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

// pnpm 11.0.9 only honours override selectors written to package.json's `pnpm.overrides` field on a non-workspace project — an equivalent `overrides:` key in pnpm-workspace.yaml is silently ignored (confirmed empirically). Confirmed empirically too: `pnpm update <name>` reliably re-resolves an already-locked package against a newly added override; a plain `pnpm install` (incremental or --force, with no package named) does not. `pnpm update` is also load-bearing for staying targeted — deleting node_modules/pnpm-lock.yaml and reinstalling from scratch also applies overrides, but incidentally re-resolves every *other* dependency (including dev tooling like prettier/eslint) to whatever satisfies its own range today, which can silently change formatting/lint rules for code this script never touched and break the commit step's own pre-push hook on files with no relation to the fix.
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

function githubAdvisoryIdsIn(report: AuditReport): Set<string> {
  return new Set(
    Object.values(report.advisories).map((a) => a.github_advisory_id),
  );
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

function restoreFromGit(): void {
  spawnSync("git", ["checkout", "--", LOCKFILE, PACKAGE_FILE], {
    encoding: "utf8",
  });
  // `pnpm update` only touches the packages it's told to; a plain `git checkout` restores the two tracked files but leaves node_modules linked against whatever the last attempt resolved, so resync it for whatever runs next (the final re-audit below, or any later step in this same job).
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

// pnpm's own exit code from `update` is not a reliable signal that an override actually took effect — confirmed empirically: an unsatisfiable override (no published version clears it) still exits 0, silently leaving the package at whatever it could otherwise resolve. The only trustworthy signal is re-auditing and checking whether each candidate's own specific advisories are gone. A non-zero exit from `update` itself does mean something more fundamental broke (e.g. an unresolvable peer conflict) and is reported as `conflicted` so the caller can isolate which candidate is responsible.
function attemptBatch(
  pkgBefore: Record<string, unknown>,
  baseOverrides: Record<string, string>,
  batch: Candidate[],
): { succeeded: Candidate[]; conflicted: boolean } {
  const overrides = { ...baseOverrides };
  for (const c of batch) overrides[c.overrideKey] = c.range;
  writePackageJson(withOverrides(pkgBefore, overrides));

  const names = [
    ...new Set(batch.flatMap((c) => c.advisories.map((a) => a.module_name))),
  ];
  const updated =
    spawnSync("pnpm", ["update", ...names], { encoding: "utf8" }).status === 0;
  if (!updated) {
    return { succeeded: [], conflicted: true };
  }

  const present = githubAdvisoryIdsIn(runAudit());
  const succeeded = batch.filter((c) =>
    c.advisories.every((a) => !present.has(a.github_advisory_id)),
  );
  return { succeeded, conflicted: false };
}

// A single candidate whose override the registry can never satisfy (or that conflicts with peers) must not sink every other, independently-fixable candidate in the same batch. attemptBatch's own audit check already tells us exactly which candidates in a batch succeeded when the update itself ran cleanly, so bisection is only needed to isolate a genuine `conflicted` (non-zero exit) failure; if two halves that each update fine independently still conflict combined, fall back to a linear greedy pass, which always terminates with a verified-working subset.
function resolveMaximalSubset(
  pkgBefore: Record<string, unknown>,
  baseOverrides: Record<string, string>,
  batch: Candidate[],
): Candidate[] {
  if (batch.length === 0) return [];

  const attempt = attemptBatch(pkgBefore, baseOverrides, batch);
  if (!attempt.conflicted) return attempt.succeeded;
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

  const combinedAttempt = attemptBatch(pkgBefore, baseOverrides, combined);
  if (!combinedAttempt.conflicted) return combinedAttempt.succeeded;

  return greedyResolve(pkgBefore, baseOverrides, combined);
}

function greedyResolve(
  pkgBefore: Record<string, unknown>,
  baseOverrides: Record<string, string>,
  batch: Candidate[],
): Candidate[] {
  const working: Candidate[] = [];
  for (const c of batch) {
    const attempt = attemptBatch(pkgBefore, baseOverrides, [...working, c]);
    if (!attempt.conflicted && attempt.succeeded.includes(c)) {
      working.push(c);
    }
  }
  return working;
}

const initial = runAudit();
const advisories = Object.values(initial.advisories);
const initialIds = githubAdvisoryIdsIn(initial);

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

  // Land on a final, clean state: exactly the overrides that verified as fixed, so the committed lockfile never carries an inert entry for a candidate that didn't pan out.
  if (fixed.length > 0) {
    const final = attemptBatch(pkgBefore, baseOverrides, fixed);
    if (final.conflicted || final.succeeded.length !== fixed.length) {
      fail(
        "Could not reproduce the verified-working override set on the final update pass",
      );
    }
  } else {
    restoreFromGit();
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

// Anything at or above the audit level that wasn't present before this run's changes is a brand-new problem introduced by an override or by its transitive fallout — never ship that silently just because the advisories we set out to fix are gone.
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
