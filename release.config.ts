import type { GlobalConfig } from "semantic-release";

type ReleaseLevel = "major" | "minor" | "patch" | false;

interface CommitType {
  readonly type: string;
  readonly release: ReleaseLevel;
  readonly section: string;
}

/**
 * Single source of truth for the conventional-commit types this project uses. commitlint's allowed type-enum (commitlint.config.ts imports this) and both the commit-analyzer's releaseRules and the release-notes generator's per-type sections below derive from it, so a type can't trigger a release without also being accepted by commit-msg validation, or the reverse.
 *
 * Defined here rather than in a sibling module: semantic-release loads this file via cosmiconfig, which transpiles only this one file, so a separate .ts module would not resolve from it. commitlint's jiti loader has no such limit, so it imports commitTypes from here.
 */
export const commitTypes: readonly CommitType[] = [
  { type: "feat", release: "minor", section: "Features" },
  { type: "fix", release: "patch", section: "Bug Fixes" },
  { type: "revert", release: "patch", section: "Reverts" },
  { type: "refactor", release: "patch", section: "Refactoring" },
  { type: "perf", release: "patch", section: "Performance Improvements" },
  { type: "docs", release: "patch", section: "Documentation" },
  { type: "style", release: "patch", section: "Styles" },
  { type: "test", release: "patch", section: "Tests" },
  { type: "build", release: "patch", section: "Build" },
  { type: "ci", release: "patch", section: "CI" },
  { type: "chore", release: "patch", section: "Chores" },
];

const config: GlobalConfig = {
  branches: [{ name: "main", channel: "latest" }],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { breaking: true, release: "major" },
          ...commitTypes.map((t) => ({ type: t.type, release: t.release })),
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        presetConfig: {
          types: commitTypes.map((t) => ({ type: t.type, section: t.section })),
        },
      },
    ],
    "@semantic-release/changelog",
    "@semantic-release/npm",
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          "jq --indent 2 '.version = \"${nextRelease.version}\"' .claude-plugin/plugin.json > /tmp/plugin.json && mv /tmp/plugin.json .claude-plugin/plugin.json",
      },
    ],
    [
      "@semantic-release/git",
      {
        assets: ["package.json", "CHANGELOG.md", ".claude-plugin/plugin.json"],
        message: "chore(release): ${nextRelease.version}",
      },
    ],
    [
      "@semantic-release/github",
      {
        releasedLabels: false,
      },
    ],
  ],
};

export default config;
