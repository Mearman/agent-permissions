import { type KnipConfig } from 'knip';

const config: KnipConfig = {
  // The exports map is a wildcard over dist/* mirroring every top-level src module, so each src/*.ts file is public surface by construction -- making them all entries keeps knip from false-positiving the public API while still catching unused files, dependencies, and anything else nothing reaches.
  entry: ['src/*.ts'],
  project: ['src/**/*.ts', '.github/scripts/**/*.ts'],
  ignoreBinaries: ['info'],
  ignoreDependencies: [
    // Loaded by semantic-release via plugin-name strings in release.config.ts, invisible to static analysis
    '@semantic-release/github',
    '@semantic-release/npm',
    'conventional-changelog-conventionalcommits',
    // A deliberate direct pin of tsdown's bundling engine, not an import
    'rolldown',
    // Marked external for the bundle by regex in tsdown.config.ts, not imported
    'undici-types',
  ],
};

export default config;
