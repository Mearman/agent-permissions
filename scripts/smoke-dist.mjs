// Exercises the built dist the way a consumer would, not the TypeScript source the test suite runs against: imports the ESM entry, requires the CJS entry through createRequire, and runs the CLI binary's --help. Run after `pnpm build` (pkgcheck does this). Exits non-zero on the first failure.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const esm = await import('../dist/api.mjs');
const expected = ['convert', 'validate', 'check', 'detectFormat'];
for (const name of expected) {
  if (typeof esm[name] !== 'function') {
    console.error(`dist/api.mjs does not export ${name}`);
    process.exit(1);
  }
}

const require = createRequire(import.meta.url);
const cjs = require('../dist/api.cjs');
for (const name of expected) {
  if (typeof cjs[name] !== 'function') {
    console.error(`dist/api.cjs does not export ${name}`);
    process.exit(1);
  }
}

execFileSync(process.execPath, ['dist/cli.mjs', '--help'], {
  stdio: 'inherit',
});
console.log('dist smoke: ESM, CJS, and CLI entry points all resolve and run');
