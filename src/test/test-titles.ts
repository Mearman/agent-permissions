/** Lists the tests a test file registers, by the title the runner prints: the `describe` titles and the test title joined with ` > `. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export interface TestTitle {
  /** The test file's name. */
  file: string;
  /** The `describe` titles and the test's own, joined with ` > `. A title built in a loop is as written, `${...}` included. */
  title: string;
}

const SUITES = new Set(["describe", "suite"]);
const TESTS = new Set(["it", "test"]);

/** A title as written: a string's value, a template's text with its substitutions left in, or any other expression as `${expression}`. */
function titleOf(node: ts.Expression): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1);
  return `\${${node.getText()}}`;
}

/** The titles of every test in one file. */
function titlesIn(file: string, text: string): TestTitle[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: TestTitle[] = [];
  const path: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const [first] = node.arguments;
      const name = node.expression.text;
      if (first !== undefined && (SUITES.has(name) || TESTS.has(name))) {
        const title = titleOf(first);
        if (TESTS.has(name)) {
          found.push({ file, title: [...path, title].join(" > ") });
          return;
        }
        path.push(title);
        ts.forEachChild(node, visit);
        path.pop();
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every test in the directory's `*.test.ts` files except the named ones, in file order. */
export function testTitles(
  directory: string,
  exclude: readonly string[],
): TestTitle[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".test.ts") && !exclude.includes(name))
    .sort()
    .flatMap((name) =>
      titlesIn(name, readFileSync(join(directory, name), "utf-8")),
    );
}
