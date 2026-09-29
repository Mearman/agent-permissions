/** `watchPolicy` reloads the policy when a layer changes and reports a layer it cannot read. */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { evaluate, type PermissionPolicy } from "../evaluate.ts";
import { watchPolicy, type PolicyWatcher } from "../loader.ts";

const EVENT_TIMEOUT_MS = 10_000;
const QUIET_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** The next value a callback receives, or a rejection when none arrives in time. */
function next<T>(
  what: string,
  queue: T[],
  waiters: ((value: T) => void)[],
): Promise<T> {
  const ready = queue.shift();
  if (ready !== undefined) return Promise.resolve(ready);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no ${what} before the timeout`));
    }, EVENT_TIMEOUT_MS);
    waiters.push((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

void describe("watchPolicy", () => {
  const dirs: string[] = [];
  const watchers: PolicyWatcher[] = [];
  after(async () => {
    for (const watcher of watchers) watcher.close();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true })));
  });

  async function start(initial: object | undefined) {
    const cwd = await mkdtemp(join(tmpdir(), "watch-test-"));
    dirs.push(cwd);
    if (initial !== undefined) {
      await mkdir(join(cwd, ".agents"), { recursive: true });
      await writeFile(
        join(cwd, ".agents", "permissions.json"),
        JSON.stringify(initial),
      );
    }
    const changes: PermissionPolicy[] = [];
    const changeWaiters: ((policy: PermissionPolicy) => void)[] = [];
    const errors: Error[] = [];
    const errorWaiters: ((error: Error) => void)[] = [];
    const watcher = watchPolicy(
      { cwd },
      (policy) => {
        const waiter = changeWaiters.shift();
        if (waiter) waiter(policy);
        else changes.push(policy);
      },
      (error) => {
        const waiter = errorWaiters.shift();
        if (waiter) waiter(error);
        else errors.push(error);
      },
    );
    watchers.push(watcher);
    // The first report is the policy as it loads; changes are made after it.
    await next("initial policy", changes, changeWaiters);
    return {
      cwd,
      watcher,
      nextPolicy: () => next("policy", changes, changeWaiters),
      nextError: () => next("error", errors, errorWaiters),
      changes,
      errors,
    };
  }

  const file = (cwd: string): string =>
    join(cwd, ".agents", "permissions.json");

  void it("reports the new policy when a layer file changes", async () => {
    const w = await start({
      rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
    });
    await writeFile(
      file(w.cwd),
      JSON.stringify({
        rules: [
          { tool: "Bash", pattern: "git:*", tier: "allow" },
          { tool: "Bash", pattern: "git push:*", tier: "deny" },
        ],
      }),
    );
    const policy = await w.nextPolicy();
    assert.equal(evaluate(policy, "Bash", "git push origin"), "deny");
  });

  void it("reports a layer file created after the watch began, in a new directory", async () => {
    const w = await start(undefined);
    await mkdir(join(w.cwd, ".agents"), { recursive: true });
    await writeFile(
      file(w.cwd),
      JSON.stringify({
        rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
      }),
    );
    const policy = await w.nextPolicy();
    assert.equal(evaluate(policy, "Bash", "rm x"), "deny");
  });

  void it("stays quiet when a change leaves the policy as it was", async () => {
    const w = await start({
      rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
    });
    await writeFile(join(w.cwd, ".agents", "notes.txt"), "unrelated");
    await writeFile(
      file(w.cwd),
      JSON.stringify(
        { rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }] },
        null,
        4,
      ),
    );
    await sleep(QUIET_MS);
    assert.deepEqual(w.changes, []);
  });

  void it("reports a file it cannot read, and does not report a policy without it", async () => {
    const w = await start({
      rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
    });
    await writeFile(file(w.cwd), "{ not json");
    const error = await w.nextError();
    assert.match(error.message, /permissions\.json/);
    await sleep(QUIET_MS);
    assert.deepEqual(w.changes, []);

    await writeFile(
      file(w.cwd),
      JSON.stringify({
        rules: [{ tool: "Bash", pattern: "rm:*", tier: "ask" }],
      }),
    );
    const policy = await w.nextPolicy();
    assert.equal(evaluate(policy, "Bash", "rm x"), "ask");
  });

  void it("stops reporting once closed", async () => {
    const w = await start({
      rules: [{ tool: "Bash", pattern: "git:*", tier: "allow" }],
    });
    w.watcher.close();
    await writeFile(
      file(w.cwd),
      JSON.stringify({
        rules: [{ tool: "Bash", pattern: "rm:*", tier: "deny" }],
      }),
    );
    await sleep(QUIET_MS);
    assert.deepEqual(w.changes, []);
  });
});
