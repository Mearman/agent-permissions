import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cleanup } from "./native-config-fixture.ts";

after(cleanup);

void describe("no async call is left running without a catch", () => {
  /** The functions that may be called with `void` because they never reject. */
  const NEVER_REJECT = new Set(["syncInBackground"]);

  void it("calls only a function that never rejects, in a statement that discards its promise", () => {
    const source = join(import.meta.dirname, "..");
    const offenders: string[] = [];
    for (const name of readdirSync(source).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(source, name), "utf-8");
      for (const match of text.matchAll(/^\s*void ([\w.]+)\(/gmu)) {
        const callee = match[1];
        if (callee !== undefined && !NEVER_REJECT.has(callee)) {
          offenders.push(`${name}: void ${callee}(`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});
