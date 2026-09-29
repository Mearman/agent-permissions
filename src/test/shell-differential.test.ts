/**
 * Differential test of the shell splitter against real bash.
 *
 * Every generated line is made only of marker functions that append their own name to a file, plus `echo`, `:` and redirections to /dev/null, so running it has no effect beyond that file. The property under test is the one the permission check relies on: any command bash actually runs must appear as a command in the splitter's output, or the splitter must decline the line.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { splitShellCommand } from "../shell.ts";

const MARKERS = ["m0", "m1", "m2", "m3", "m4"] as const;
const CASES = Number(process.env.SHELL_DIFFERENTIAL_CASES ?? 600);
const SEED = Number(process.env.SHELL_DIFFERENTIAL_SEED ?? 20260929);
/** Below this share of splittable lines the test would be checking too little to mean anything. */
const MIN_SPLITTABLE_SHARE = 0.25;

/** A small deterministic generator, so a failure reproduces from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(random: () => number) {
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)] as T;

  const marker = (): string => pick(MARKERS);
  const simple = (): string =>
    pick([
      marker(),
      marker(),
      marker(),
      `echo ${marker()}`,
      ":",
      `FOO=1 ${marker()}`,
      `${marker()} arg`,
      `${marker()} > /dev/null`,
      `${marker()} 2>&1`,
      `${marker()} &> /dev/null`,
      `${marker()} >&2`,
      `${marker()} >| /dev/null`,
      `echo a\\;${marker()}`,
      `echo "a;${marker()}"`,
      `echo 'a;${marker()}'`,
      `echo $'a;${marker()}'`,
      `echo a\\&\\&${marker()}`,
      `echo \\$(${marker()})`,
      `echo "\\$(${marker()})"`,
      `echo $"a;${marker()}"`,
      `cat <<< $(${marker()})`,
      `echo $[ 1 + 1 ]; ${marker()}`,
      `echo \${#X} $# a#b; ${marker()}`,
      `test -n $(${marker()})`,
      `echo '\\'; ${marker()}`,
      `${marker()} >/dev/null&${marker()}`,
    ]);
  const separators = [
    " ; ",
    ";",
    " && ",
    " || ",
    " | ",
    " & ",
    "\n",
    " |& ",
    "&&",
    "||",
  ] as const;

  function command(depth: number): string {
    if (depth <= 0) return simple();
    switch (Math.floor(random() * 14)) {
      case 0:
        return `${command(depth - 1)}${pick(separators)}${command(depth - 1)}`;
      case 1:
        return `echo $(${command(depth - 1)})`;
      case 2: {
        // Backticks do not nest unescaped, so an inner backtick becomes a $( ) substitution
        const inner = command(depth - 1);
        return inner.includes("`") ? `echo $(${inner})` : `echo \`${inner}\``;
      }
      case 3:
        return `echo "$(${command(depth - 1)})"`;
      case 4:
        return `cat <(${command(depth - 1)})`;
      case 5:
        return `(${command(depth - 1)})`;
      case 6:
        return `{ ${command(depth - 1)}; }`;
      case 7:
        return `if true; then ${command(depth - 1)}; fi`;
      case 8:
        return `for i in 1; do ${command(depth - 1)}; done`;
      case 9:
        return `${command(depth - 1)} # ${marker()}`;
      case 10:
        return `echo "a $(${command(depth - 1)}) b"`;
      case 11:
        return `echo \${X:-$(${command(depth - 1)})}`;
      case 12:
        return `echo '$(${marker()})'; ${command(depth - 1)}`;
      default:
        return simple();
    }
  }

  return () => command(1 + Math.floor(random() * 3));
}

/** The first word of a command that is not a variable assignment. */
function commandWord(command: string): string | undefined {
  for (const word of command.split(/\s+/)) {
    if (word === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return word;
  }
  return undefined;
}

void describe("splitShellCommand against bash", () => {
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "shell-differential-"));
  });
  after(async () => {
    await rm(dir, { recursive: true });
  });

  void it("lists every command bash runs, or declines the line", async () => {
    const out = join(dir, "ran");
    const prelude = MARKERS.map(
      (m) => `${m}() { echo ${m} >> '${out}'; }`,
    ).join("\n");

    const next = generator(mulberry32(SEED));
    let splittable = 0;
    const failures: string[] = [];

    for (let i = 0; i < CASES; i++) {
      const line = next();
      const commands = splitShellCommand(line);
      if (commands === undefined) continue;
      splittable += 1;

      spawnSync("bash", ["-c", `: > '${out}'`]);
      spawnSync("bash", ["-c", `${prelude}\n${line}`], {
        timeout: 5000,
        input: "",
      });
      const ran = new Set(
        (await readFile(out, "utf8")).split("\n").filter((l) => l !== ""),
      );
      const listed = new Set(commands.map(commandWord));
      const missed = [...ran].filter((m) => !listed.has(m));
      if (missed.length > 0) {
        failures.push(
          `${JSON.stringify(line)} ran ${missed.join(",")} but split into ${JSON.stringify(commands)}`,
        );
      }
    }

    assert.deepEqual(failures.slice(0, 5), [], `seed ${String(SEED)}`);
    assert.ok(
      splittable / CASES >= MIN_SPLITTABLE_SHARE,
      `only ${String(splittable)} of ${String(CASES)} lines were splittable`,
    );
  });
});
