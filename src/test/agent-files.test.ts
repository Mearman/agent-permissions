/**
 * Unit tests for agent-files.ts — parseJson, validatePolicy, decodeNative, writeJsonFile,
 * findDefaultFile, defaultFileName.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  findDefaultFile,
  ompGlobalConfigPath,
  writeJsonFile,
} from "../agent-files.ts";

void describe("agent-files", () => {
  const dirs: string[] = [];

  function isolate(): string {
    const dir = mkdtempSync(join(tmpdir(), "agent-files-test-"));
    dirs.push(dir);
    return dir;
  }

  // Clean up temp dirs after all tests
  process.on("exit", () => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  });

  // -------------------------------------------------------------------------
  void describe("findDefaultFile", () => {
    void it("finds file in current directory", () => {
      const dir = isolate();
      mkdirSync(join(dir, ".agents"), { recursive: true });
      writeFileSync(join(dir, ".agents", "permissions.json"), "{}");

      assert.strictEqual(
        findDefaultFile("canonical", dir),
        join(dir, ".agents", "permissions.json"),
      );
    });

    void it("walks up to parent directory", () => {
      const dir = isolate();
      const child = join(dir, "sub", "deep");
      mkdirSync(join(dir, ".agents"), { recursive: true });
      writeFileSync(join(dir, ".agents", "permissions.json"), "{}");
      mkdirSync(child, { recursive: true });

      assert.strictEqual(
        findDefaultFile("canonical", child),
        join(dir, ".agents", "permissions.json"),
      );
    });

    void it("returns default path when no file found", () => {
      const dir = isolate();
      const child = join(dir, "sub");
      mkdirSync(child, { recursive: true });

      assert.strictEqual(
        findDefaultFile("canonical", child),
        join(child, ".agents", "permissions.json"),
      );
    });

    void it("finds claude-code settings", () => {
      const dir = isolate();
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(join(dir, ".claude", "settings.json"), "{}");

      assert.strictEqual(
        findDefaultFile("claude-code", dir),
        join(dir, ".claude", "settings.json"),
      );
    });

    void it("finds opencode.json", () => {
      const dir = isolate();
      writeFileSync(join(dir, "opencode.json"), "{}");

      assert.strictEqual(
        findDefaultFile("opencode", dir),
        join(dir, "opencode.json"),
      );
    });
  });

  // -------------------------------------------------------------------------
  void describe("writeJsonFile", () => {
    void it("writes to existing directory", async () => {
      const dir = isolate();
      const filePath = join(dir, "output.json");
      await writeJsonFile(filePath, '{"test": true}');

      const { readFileSync } = await import("node:fs");
      assert.strictEqual(readFileSync(filePath, "utf-8"), '{"test": true}');
    });

    void it("creates parent directories", async () => {
      const dir = isolate();
      const filePath = join(dir, "sub", "dir", "output.json");
      await writeJsonFile(filePath, '{"nested": true}');

      const { readFileSync } = await import("node:fs");
      assert.strictEqual(readFileSync(filePath, "utf-8"), '{"nested": true}');
    });

    void it("overwrites existing file", async () => {
      const dir = isolate();
      const filePath = join(dir, "output.json");
      writeFileSync(filePath, "old content");
      await writeJsonFile(filePath, "new content");

      const { readFileSync } = await import("node:fs");
      assert.strictEqual(readFileSync(filePath, "utf-8"), "new content");
    });
  });
});

void describe("Oh My Pi config files", () => {
  void it("takes the global config from the agent directory, preferring config.yml", () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-agent-"));
    try {
      assert.strictEqual(ompGlobalConfigPath(dir), join(dir, "config.yml"));
      writeFileSync(join(dir, "config.yaml"), "model: x\n");
      assert.strictEqual(ompGlobalConfigPath(dir), join(dir, "config.yaml"));
      writeFileSync(join(dir, "config.yml"), "model: y\n");
      assert.strictEqual(ompGlobalConfigPath(dir), join(dir, "config.yml"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
