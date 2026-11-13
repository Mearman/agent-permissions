import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSerialRunner, syncInBackground } from "../mcp.ts";
import { writeFileAtomic } from "../agent-files.ts";
import { cleanup, denyRm, project, put } from "./native-config-fixture.ts";

after(cleanup);

void describe("one sync is in flight at a time", () => {
  void it("never overlaps runs, and collapses requests made during a run into one follow-up", async () => {
    let running = 0;
    let peak = 0;
    let runs = 0;
    const release: (() => void)[] = [];
    const request = createSerialRunner(async () => {
      runs++;
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running--;
    });

    const first = request();
    const during = [request(), request(), request(), request()];
    assert.equal(runs, 1);
    release.shift()?.();
    // The follow-up starts once the first run has finished.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 2);
    const late = request();
    release.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runs, 3);
    release.shift()?.();
    await Promise.all([first, ...during, late]);

    assert.equal(peak, 1);
    assert.equal(runs, 3);
  });

  void it("runs again after a run that failed", async () => {
    let runs = 0;
    const request = createSerialRunner(() => {
      runs++;
      return runs === 1
        ? Promise.reject(new Error("first fails"))
        : Promise.resolve();
    });

    await assert.rejects(request(), /first fails/u);
    await request();

    assert.equal(runs, 2);
  });

  void it("does not report its own writes as a failure when events arrive while it runs", async () => {
    const cwd = await project({ rules: [denyRm] });
    await put(cwd, ".claude/settings.json", '{"model": "x"}\n');
    await put(cwd, "opencode.json", '{"permission": {"read": "allow"}}\n');
    await put(cwd, ".kiro/permissions.json", '{"allowedTools": ["read"]}\n');
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (data: string | Uint8Array): boolean => {
      chunks.push(String(data));
      return true;
    };
    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          syncInBackground(cwd, { mode: "watch", backup: false }),
        ),
      );
    } finally {
      process.stderr.write = original;
    }

    assert.doesNotMatch(chunks.join(""), /Sync stopped/u);
    assert.match(
      await readFile(join(cwd, ".claude", "settings.json"), "utf-8"),
      /Bash\(rm:\*\)/u,
    );
  });
});

void describe("the file is checked again immediately before the rename", () => {
  void it("refuses to replace a file that changed after the temporary file was written", async () => {
    const cwd = await project({});
    const path = await put(cwd, "a.json", '{"a": 1}\n');

    await assert.rejects(
      writeFileAtomic(path, '{"a": 2}\n', '{"a": 1}\n', {
        afterTemporaryWritten: async () => {
          await put(cwd, "a.json", '{"a": 3}\n');
        },
      }),
      /changed since it was read/u,
    );

    assert.equal(await readFile(path, "utf-8"), '{"a": 3}\n');
  });
});
