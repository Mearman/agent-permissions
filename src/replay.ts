/**
 * Replaying a policy over a recorded agent session, and proposing allow rules from one.
 *
 * Import: import { parseTranscript, replayCalls, suggestRules } from "agent-perms/replay";
 *
 * The transcript format is Claude Code's session log: JSON Lines, one entry per line. The parser relies on these fields only:
 *
 * - `message.content[]` blocks of `type: "tool_use"`, with `id`, `name` and `input`, for each call.
 * - `message.content[]` blocks of `type: "tool_result"`, with `tool_use_id`, `is_error` and `content` (a string, or a list of `{ type: "text", text }` blocks), for how each call ended.
 * - `cwd` and `gitBranch` on the entry holding the `tool_use` block, as the call's context. The log records no environment variables or git remote, so conditions on those stay unknown.
 *
 * The transcript does not record which rule decided a call, or whether a call that ran was allowed outright or approved when asked. It records only the outcome, read from the result: an error starting `Permission to use ` and containing ` has been denied` means a rule denied it, an error starting `The user doesn't want to proceed with this tool use.` means the user declined when asked, and any other result means it ran. A call with no result has no recorded outcome.
 */

import {
  compile,
  explain,
  type CompiledPolicy,
  type DecisionStep,
  type EvaluationContext,
  type PermissionDecision,
  type PermissionPolicy,
} from "./evaluate.ts";
import { isRecord } from "./guards.ts";
import type { Rule } from "./schema.ts";
import { splitShellCommand } from "./shell.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a recorded call ended: it ran, a rule denied it, or the user declined it when asked. */
export type RecordedOutcome = "ran" | "denied" | "rejected";

/** One tool call read from a transcript. */
export interface ToolCall {
  /** The tool name as the agent called it. */
  tool: string;
  /**
   * What rule patterns match against: the command, file path or URL. Absent for a tool with no such input, which only a rule without a pattern can match.
   */
  subject?: string;
  /** The working directory and branch recorded with the call, where the transcript has them. */
  context: EvaluationContext;
  /** How the call ended, when the transcript records its result. */
  outcome?: RecordedOutcome;
}

/** A call judged against a policy. */
export interface ReplayedCall {
  call: ToolCall;
  decision: PermissionDecision;
  steps: DecisionStep[];
}

/** The result of replaying a policy over recorded calls. */
export interface ReplayReport {
  /** How many calls the policy would allow, ask about and deny. */
  counts: Record<PermissionDecision, number>;
  /** The calls whose recorded outcome the policy's decision could not have produced, in order. */
  differing: ReplayedCall[];
}

/** A proposed allow rule and how many approved calls it covers. */
export interface Suggestion {
  rule: Rule;
  count: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The input field each tool's rule patterns match against. A tool not listed has no such field, so only a rule without a pattern applies to it.
 */
const SUBJECT_FIELDS: Readonly<Record<string, string>> = {
  bash: "command",
  read: "file_path",
  write: "file_path",
  edit: "file_path",
  multiedit: "file_path",
  notebookedit: "notebook_path",
  webfetch: "url",
};

const DENIED_PREFIX = "Permission to use ";
const DENIED_MARKER = " has been denied";
const REJECTED_PREFIX = "The user doesn't want to proceed with this tool use.";

/**
 * Read the tool calls from a JSON Lines session transcript, in the order they were made.
 *
 * @throws {SyntaxError} When a non-blank line is not JSON, naming the line.
 */
export function parseTranscript(text: string): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  const outcomes = new Map<string, RecordedOutcome>();

  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new SyntaxError(
        `transcript line ${String(index + 1)} is not JSON: ${reason}`,
        { cause: e },
      );
    }
    if (!isRecord(entry) || !isRecord(entry.message)) return;
    const { content } = entry.message;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!isRecord(block)) continue;
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        !calls.has(block.id)
      ) {
        calls.set(block.id, readCall(block.name, block.input, entry));
      } else if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        outcomes.set(block.tool_use_id, readOutcome(block));
      }
    }
  });

  return [...calls].map(([id, call]) => {
    const outcome = outcomes.get(id);
    return outcome === undefined ? call : { ...call, outcome };
  });
}

function readCall(
  tool: string,
  input: unknown,
  entry: Record<string, unknown>,
): ToolCall {
  const context: EvaluationContext = {};
  if (typeof entry.cwd === "string") context.cwd = entry.cwd;
  if (typeof entry.gitBranch === "string") context.branch = entry.gitBranch;

  const field = SUBJECT_FIELDS[tool.toLowerCase()];
  const subject =
    field !== undefined && isRecord(input) ? input[field] : undefined;
  return typeof subject === "string"
    ? { tool, subject, context }
    : { tool, context };
}

function readOutcome(block: Record<string, unknown>): RecordedOutcome {
  if (block.is_error !== true) return "ran";
  const text = resultText(block.content);
  if (text.startsWith(DENIED_PREFIX) && text.includes(DENIED_MARKER)) {
    return "denied";
  }
  if (text.startsWith(REJECTED_PREFIX)) return "rejected";
  return "ran";
}

/** The text of a result's content: the string itself, or its text blocks joined. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * The decisions that can produce each recorded outcome. A call that ran was allowed or approved when asked; a denied call was denied; a call the user declined was asked about.
 */
const PRODUCED_BY: Readonly<
  Record<RecordedOutcome, readonly PermissionDecision[]>
> = {
  ran: ["allow", "ask"],
  denied: ["deny"],
  rejected: ["ask"],
};

/** Judge a call against a compiled policy, as {@link explain} judges one. */
function judge(policy: CompiledPolicy, call: ToolCall): ReplayedCall {
  const { decision, steps } = policy.explain(
    call.tool,
    call.subject ?? "",
    call.context,
  );
  return { call, decision, steps };
}

/**
 * Judge every call against a policy: count the decisions, and list the calls whose recorded outcome that decision could not have produced. A call with no recorded outcome is counted but never listed.
 */
export function replayCalls(
  policy: PermissionPolicy,
  calls: readonly ToolCall[],
): ReplayReport {
  const counts: Record<PermissionDecision, number> = {
    allow: 0,
    ask: 0,
    deny: 0,
  };
  const differing: ReplayedCall[] = [];
  const compiled = compile(policy);
  for (const call of calls) {
    const replayed = judge(compiled, call);
    counts[replayed.decision]++;
    if (
      call.outcome !== undefined &&
      !PRODUCED_BY[call.outcome].includes(replayed.decision)
    ) {
      differing.push(replayed);
    }
  }
  return { counts, differing };
}

// ---------------------------------------------------------------------------
// Suggest
// ---------------------------------------------------------------------------

/** One command or subject that can be allowed on its own. */
interface Unit {
  tool: string;
  subject: string | undefined;
}

/** A key identifying a unit, with tool names compared case-insensitively as rules compare them. */
function unitKey(unit: Unit): string {
  return JSON.stringify([unit.tool.toLowerCase(), unit.subject ?? null]);
}

/**
 * The units a call is made of: each command of a Bash line, or the call's subject. `undefined` for a shell line the splitter does not model, which no rule may allow command by command.
 */
function unitsOf(call: ToolCall): Unit[] | undefined {
  if (call.tool.toLowerCase() !== "bash" || call.subject === undefined) {
    return [{ tool: call.tool, subject: call.subject }];
  }
  return splitShellCommand(call.subject)?.map((subject) => ({
    tool: call.tool,
    subject,
  }));
}

/** Escape pattern syntax so a pattern matches `text` literally. */
function literal(text: string): string {
  return text.replace(/[\\()*]/g, "\\$&");
}

/** Whether `rule` on its own matches `unit`. */
function covers(rule: Rule, unit: Unit): boolean {
  return explain(
    { defaultMode: "readonly", rules: [rule] },
    unit.tool,
    unit.subject ?? "",
  ).steps.some((step) => step.rule === rule);
}

/** The words of a command, split on whitespace. */
function words(command: string): string[] {
  return command.trim().split(/\s+/);
}

/**
 * The words every command starts with, stopping before the first word that differs or carries quoting or pattern syntax, where a word boundary in the text is not a word boundary to the shell.
 */
function sharedWords(commands: readonly string[]): string[] {
  const [first, ...rest] = commands.map(words);
  if (first === undefined) return [];
  const shared: string[] = [];
  for (const [i, word] of first.entries()) {
    if (/["'\\()*]/.test(word)) break;
    if (!rest.every((other) => other[i] === word)) break;
    shared.push(word);
  }
  return shared;
}

interface Tally {
  unit: Unit;
  count: number;
}

/**
 * The narrowest allow rules for one group of approved units: an exact rule when they are all the same, otherwise a prefix rule on the words they share. A prefix that would also match an excluded unit is dropped for exact rules on the units approved at least `minCount` times.
 */
function rulesForGroup(
  tallies: readonly Tally[],
  excluded: readonly Unit[],
  minCount: number,
): Suggestion[] {
  const exact = (tally: Tally): Suggestion => ({
    rule:
      tally.unit.subject === undefined
        ? { tool: tally.unit.tool, tier: "allow" }
        : {
            tool: tally.unit.tool,
            pattern: literal(tally.unit.subject),
            tier: "allow",
          },
    count: tally.count,
  });
  const exacts = (): Suggestion[] =>
    tallies.filter((t) => t.count >= minCount).map(exact);

  const [only] = tallies;
  if (only !== undefined && tallies.length === 1) return exacts();

  const shared = sharedWords(tallies.map((t) => t.unit.subject ?? ""));
  const tool = only?.unit.tool;
  if (tool === undefined || shared.length === 0) return exacts();

  const prefix: Rule = {
    tool,
    pattern: `${literal(shared.join(" "))}:*`,
    tier: "allow",
  };
  const count = tallies.reduce((sum, t) => sum + t.count, 0);
  if (count < minCount || excluded.some((unit) => covers(prefix, unit))) {
    return exacts();
  }
  return [{ rule: prefix, count }];
}

/**
 * Propose allow rules for what the transcript shows was approved at least `minCount` times.
 *
 * Only calls that ran count as approved. A Bash line is taken command by command, and a line the shell splitter does not model is skipped. A command is never proposed when it appeared in a line a rule of `policy` denies, or in a line the transcript records as denied or declined, and a command `policy` already allows, or a rule of it asks about, is left out. Bash commands sharing a first word become one prefix rule on the words they all start with, unless that prefix would also match such an excluded command; everything else gets an exact rule, or a rule without a pattern for a tool with no subject. Rules are ordered by how many calls they cover, then by first appearance.
 */
export function suggestRules(
  calls: readonly ToolCall[],
  policy: PermissionPolicy,
  minCount: number,
): Suggestion[] {
  const approved = new Map<string, Tally>();
  const excluded = new Map<string, Unit>();
  const compiled = compile(policy);

  for (const call of calls) {
    const units = unitsOf(call);
    const { steps } = judge(compiled, call);
    const refused =
      call.outcome === "denied" ||
      call.outcome === "rejected" ||
      steps.some((step) => step.reason === "rule" && step.decision === "deny");
    if (refused) {
      for (const unit of units ?? [{ tool: call.tool, subject: call.subject }])
        excluded.set(unitKey(unit), unit);
      continue;
    }
    if (call.outcome !== "ran" || units === undefined) continue;
    for (const unit of units) {
      // An allow rule changes nothing for a unit the policy already allows or a rule asks about.
      const settled = steps.some(
        (step) =>
          step.command === (unit.subject ?? "") &&
          (step.decision === "allow" || step.reason === "rule"),
      );
      if (settled) continue;
      const key = unitKey(unit);
      const tally = approved.get(key);
      if (tally === undefined) approved.set(key, { unit, count: 1 });
      else tally.count++;
    }
  }

  const excludedUnits = [...excluded.values()];
  const groups = new Map<string, Tally[]>();
  for (const [key, tally] of approved) {
    if (excluded.has(key)) continue;
    const { tool, subject } = tally.unit;
    const groupKey =
      tool.toLowerCase() === "bash" && subject !== undefined
        ? JSON.stringify(["bash", words(subject)[0]])
        : key;
    const group = groups.get(groupKey);
    if (group === undefined) groups.set(groupKey, [tally]);
    else group.push(tally);
  }

  const suggestions = [...groups.values()].flatMap((group) =>
    rulesForGroup(group, excludedUnits, minCount),
  );
  // A stable sort keeps first appearance among equal counts.
  return suggestions.sort((a, b) => b.count - a.count);
}
