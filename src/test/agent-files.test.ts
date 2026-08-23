/**
 * Unit tests for agent-files.ts — parseJson, validatePolicy, decodeNative, writeJsonFile,
 * findDefaultFile, defaultFileName.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseJson,
  validatePolicy,
  decodeNative,
  writeJsonFile,
  findDefaultFile,
  defaultFileName,
  ok,
  fail,
  type Result,
} from '../agent-files.ts';

/** Extract value from a Result, asserting it's ok. */
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok result, got: ${JSON.stringify(result)}`);
  }
  return result.value;
}

/** Extract error from a Result, asserting it's not ok. */
function unwrapErr<T>(result: Result<T>): string {
  if (result.ok) {
    throw new Error(`expected error result, got: ${JSON.stringify(result)}`);
  }
  return result.error;
}

/** Type guard for ValidateResult ok branch with errors array. */
function isErr(result: ReturnType<typeof validatePolicy>): result is {
  ok: false;
  error: string;
  errors: { path: string; message: string }[];
} {
  return !result.ok;
}

void describe('agent-files', () => {
  const dirs: string[] = [];

  function isolate(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agent-files-test-'));
    dirs.push(dir);
    return dir;
  }

  // Clean up temp dirs after all tests
  process.on('exit', () => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  });

  // -------------------------------------------------------------------------
  void describe('Result helpers', () => {
    void it('ok() creates a success result', () => {
      const result = ok(42);
      assert.deepStrictEqual(result, { ok: true, value: 42 });
    });

    void it('fail() creates a failure result', () => {
      const result: Result<number> = fail('something broke');
      assert.deepStrictEqual(result, { ok: false, error: 'something broke' });
    });
  });

  // -------------------------------------------------------------------------
  void describe('parseJson', () => {
    void it('parses valid JSON', () => {
      const result = parseJson('{"key": "value"}', 'test');
      assert.deepStrictEqual(unwrap(result), { key: 'value' });
    });

    void it('parses arrays', () => {
      const result = parseJson('[1, 2, 3]', 'test');
      assert.deepStrictEqual(unwrap(result), [1, 2, 3]);
    });

    void it('parses primitives', () => {
      const result = parseJson('"hello"', 'test');
      assert.strictEqual(unwrap(result), 'hello');
    });

    void it('returns failure for invalid JSON', () => {
      const err = unwrapErr(parseJson('{not json}', 'source.json'));
      assert.ok(err.includes('source.json'));
      assert.ok(err.includes('invalid JSON'));
    });

    void it('returns failure for empty string', () => {
      assert.strictEqual(parseJson('', 'test').ok, false);
    });

    void it('includes source in error message', () => {
      const err = unwrapErr(parseJson('!!!', 'my-config.json'));
      assert.ok(err.startsWith('my-config.json'));
    });
  });

  // -------------------------------------------------------------------------
  void describe('validatePolicy', () => {
    void it('validates a minimal canonical policy', () => {
      assert.deepStrictEqual(unwrap(validatePolicy({})), {});
    });

    void it('validates a policy with defaultMode', () => {
      assert.strictEqual(validatePolicy({ defaultMode: 'standard' }).ok, true);
    });

    void it('validates a policy with rules', () => {
      const policy = unwrap(validatePolicy({ rules: [{ tool: 'Bash', tier: 'deny' }] }));
      assert.strictEqual(policy.rules?.length, 1);
    });

    void it('returns structured errors for invalid tier', () => {
      const result = validatePolicy({
        rules: [{ tool: 'Bash', tier: 'invalid_tier' }],
      });
      assert.strictEqual(result.ok, false);
      assert.ok(isErr(result));
      assert.ok(result.errors.length > 0);
      assert.ok(result.error.includes('validation failed'));
      for (const e of result.errors) {
        assert.ok(typeof e.path === 'string');
        assert.ok(typeof e.message === 'string');
      }
    });

    void it('returns error for wrong rule shape', () => {
      const result = validatePolicy({ rules: [{ notTool: 'Bash' }] });
      assert.strictEqual(result.ok, false);
      assert.ok(isErr(result));
      assert.ok(result.errors.length > 0);
    });

    void it('validates policy with permissions compat', () => {
      assert.strictEqual(
        validatePolicy({
          permissions: { allow: ['Read'], deny: ['Bash(rm -rf /)'] },
        }).ok,
        true
      );
    });

    void it('rejects non-object input', () => {
      assert.strictEqual(validatePolicy('not an object').ok, false);
    });

    void it('rejects null input', () => {
      assert.strictEqual(validatePolicy(null).ok, false);
    });
  });

  // -------------------------------------------------------------------------
  void describe('decodeNative', () => {
    void it('fails for format with no extract (codex)', () => {
      const err = unwrapErr(decodeNative('codex', { some: 'data' }));
      assert.ok(err.includes('codex'));
      assert.ok(err.includes('no extract'));
    });

    void it('fails for format with no extract (crush)', () => {
      const err = unwrapErr(decodeNative('crush', { allowed_tools: [] }));
      assert.ok(err.includes('crush'));
    });

    void it('fails when config has no permissions payload', () => {
      const err = unwrapErr(decodeNative('claude-code', { other: 'data' }));
      assert.ok(err.includes('no permissions payload'));
    });

    void it('fails when permissions payload is null', () => {
      const err = unwrapErr(decodeNative('claude-code', { permissions: null }));
      assert.ok(err.includes('no permissions payload'));
    });

    void it('decodes Claude Code config successfully', () => {
      const policy = unwrap(
        decodeNative('claude-code', {
          permissions: { allow: ['Read'], deny: ['Bash(rm -rf /)'] },
        })
      );
      assert.strictEqual(policy.rules?.length, 2);
    });

    void it('decodes OpenCode config successfully', () => {
      const policy = unwrap(
        decodeNative('opencode', {
          permission: { bash: 'allow', read: 'deny' },
        })
      );
      assert.strictEqual(policy.rules?.length, 2);
    });

    void it('decodes Kiro config successfully (passthrough extract)', () => {
      assert.strictEqual(decodeNative('kiro', { allowedTools: ['Read'] }).ok, true);
    });

    void it('fails when raw is not an object for claude-code', () => {
      const err = unwrapErr(decodeNative('claude-code', 'not an object'));
      assert.ok(err.includes('no permissions payload'));
    });

    void it('fails when raw is null for claude-code', () => {
      assert.strictEqual(decodeNative('claude-code', null).ok, false);
    });
  });

  // -------------------------------------------------------------------------
  void describe('defaultFileName', () => {
    void it('returns path for canonical', () => {
      assert.strictEqual(defaultFileName('canonical'), '.agents/permissions.json');
    });

    void it('returns path for claude-code', () => {
      assert.strictEqual(defaultFileName('claude-code'), '.claude/settings.json');
    });

    void it('returns path for opencode', () => {
      assert.strictEqual(defaultFileName('opencode'), 'opencode.json');
    });

    void it('returns path for codex', () => {
      assert.strictEqual(defaultFileName('codex'), 'codex.toml');
    });

    void it('returns path for kiro', () => {
      assert.strictEqual(defaultFileName('kiro'), '.kiro/permissions.json');
    });

    void it('returns path for crush', () => {
      assert.strictEqual(defaultFileName('crush'), '.crush.json');
    });
  });

  // -------------------------------------------------------------------------
  void describe('findDefaultFile', () => {
    void it('finds file in current directory', () => {
      const dir = isolate();
      mkdirSync(join(dir, '.agents'), { recursive: true });
      writeFileSync(join(dir, '.agents', 'permissions.json'), '{}');

      assert.strictEqual(
        findDefaultFile('canonical', dir),
        join(dir, '.agents', 'permissions.json')
      );
    });

    void it('walks up to parent directory', () => {
      const dir = isolate();
      const child = join(dir, 'sub', 'deep');
      mkdirSync(join(dir, '.agents'), { recursive: true });
      writeFileSync(join(dir, '.agents', 'permissions.json'), '{}');
      mkdirSync(child, { recursive: true });

      assert.strictEqual(
        findDefaultFile('canonical', child),
        join(dir, '.agents', 'permissions.json')
      );
    });

    void it('returns default path when no file found', () => {
      const dir = isolate();
      const child = join(dir, 'sub');
      mkdirSync(child, { recursive: true });

      assert.strictEqual(
        findDefaultFile('canonical', child),
        join(child, '.agents', 'permissions.json')
      );
    });

    void it('finds claude-code settings', () => {
      const dir = isolate();
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'settings.json'), '{}');

      assert.strictEqual(
        findDefaultFile('claude-code', dir),
        join(dir, '.claude', 'settings.json')
      );
    });

    void it('finds opencode.json', () => {
      const dir = isolate();
      writeFileSync(join(dir, 'opencode.json'), '{}');

      assert.strictEqual(findDefaultFile('opencode', dir), join(dir, 'opencode.json'));
    });
  });

  // -------------------------------------------------------------------------
  void describe('writeJsonFile', () => {
    void it('writes to existing directory', async () => {
      const dir = isolate();
      const filePath = join(dir, 'output.json');
      await writeJsonFile(filePath, '{"test": true}');

      const { readFileSync } = await import('node:fs');
      assert.strictEqual(readFileSync(filePath, 'utf-8'), '{"test": true}');
    });

    void it('creates parent directories', async () => {
      const dir = isolate();
      const filePath = join(dir, 'sub', 'dir', 'output.json');
      await writeJsonFile(filePath, '{"nested": true}');

      const { readFileSync } = await import('node:fs');
      assert.strictEqual(readFileSync(filePath, 'utf-8'), '{"nested": true}');
    });

    void it('overwrites existing file', async () => {
      const dir = isolate();
      const filePath = join(dir, 'output.json');
      writeFileSync(filePath, 'old content');
      await writeJsonFile(filePath, 'new content');

      const { readFileSync } = await import('node:fs');
      assert.strictEqual(readFileSync(filePath, 'utf-8'), 'new content');
    });
  });
});
