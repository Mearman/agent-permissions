/**
 * Permission-prompt handling: answer a host's "may this tool call run?" question from the policy.
 *
 * Claude Code's `--permission-prompt-tool <mcp tool>` (print mode only; interactive sessions never call it) sends each prompt to an MCP tool as `{ tool_name, input, tool_use_id }` and expects back a single text block whose text is JSON: `{ behavior: "allow", updatedInput? }` or `{ behavior: "deny", message }`. There is no third answer, so a call the policy only asks about is settled by an injected {@link AskHandler}, which the host owns, or denied when there is none.
 *
 * This module has no MCP dependency: `mcp.ts` serves it as a tool, and a library host can call {@link createPermissionPrompt} directly.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import * as z from "zod";

import {
  explain,
  stepSource,
  type EvaluationContext,
  type Explanation,
  type PermissionDecision,
  type PermissionPolicy,
} from "./evaluate.ts";

/** The arguments a permission-prompt tool is called with: the tool the agent wants to run, its input, and the id of that call. */
export const PermissionPromptRequest = z.object({
  tool_name: z.string(),
  input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().optional(),
});
export type PermissionPromptRequest = z.infer<typeof PermissionPromptRequest>;

/** The answer to a permission prompt. An allow echoes the input (or a changed one); a deny tells the agent why. */
export type PermissionPromptResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** A call the policy neither allows nor denies, handed to the host to settle. */
export interface AskRequest {
  request: PermissionPromptRequest;
  /** The string whose explanation decided the call (see {@link toolSubjects}). */
  subject: string;
  /** How the policy reached `ask`, rule by rule. */
  explanation: Explanation;
}

/**
 * Settles an `ask` decision. The host decides how: show a person the request, hold it until someone approves it elsewhere, or consult another policy. The signal aborts when the agent abandons the call.
 */
export type AskHandler = (
  ask: AskRequest,
  signal: AbortSignal,
) => Promise<PermissionPromptResult>;

export interface PermissionPromptOptions {
  /** Reads the policy for each prompt, so edits to the policy files apply to the next call. */
  loadPolicy: () => Promise<PermissionPolicy>;
  /** The project root: a file inside it is judged by its `./`-relative path as well as its absolute one. */
  root: string;
  /** Conditions on a field left out here are unknown: they never allow a call, and may still deny or ask. */
  context?: EvaluationContext;
  /** Settles `ask` decisions. Without it, a call the policy asks about is denied. */
  onAsk?: AskHandler;
}

/** Answers one permission prompt. */
export type PermissionPrompt = (
  request: PermissionPromptRequest,
  signal: AbortSignal,
) => Promise<PermissionPromptResult>;

/** The input field each built-in tool is judged by, and whether it holds a file path. */
const SUBJECT_FIELDS: Readonly<
  Record<string, { field: string; path: boolean }>
> = {
  bash: { field: "command", path: false },
  read: { field: "file_path", path: true },
  write: { field: "file_path", path: true },
  edit: { field: "file_path", path: true },
  multiedit: { field: "file_path", path: true },
  notebookedit: { field: "notebook_path", path: true },
  webfetch: { field: "url", path: false },
  websearch: { field: "query", path: false },
};

/**
 * The strings a tool call's rule patterns are matched against: the command for `Bash`, the URL for `WebFetch`, the query for `WebSearch`. A file tool's path is resolved against `root` and judged in both forms a policy may write it: absolute, and `./`-relative when it lies inside `root`. Any other tool is judged by its name alone, so its one subject is empty. `undefined` when the field a tool is judged by is missing or not a string.
 */
export function toolSubjects(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  root: string,
): readonly string[] | undefined {
  const spec = SUBJECT_FIELDS[toolName.toLowerCase()];
  if (spec === undefined) return [""];
  const value = input[spec.field];
  if (typeof value !== "string") return undefined;
  if (!spec.path) return [value];
  const absolute = resolve(root, value);
  const rel = relative(root, absolute);
  if (rel === "") return [absolute, "."];
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return [absolute];
  }
  // Policies write paths with forward slashes on every platform.
  return [absolute, `./${rel.split(sep).join("/")}`];
}

const STRICTNESS: Readonly<Record<PermissionDecision, number>> = {
  deny: 2,
  ask: 1,
  allow: 0,
};

/**
 * Judge every subject and keep the strictest decision among those a rule reached, so a rule written in either path form applies. Only when no subject matched any rule does the default mode decide.
 */
function judge(
  policy: PermissionPolicy,
  toolName: string,
  subjects: readonly string[],
  context: EvaluationContext,
): { subject: string; explanation: Explanation } {
  const judged = subjects.map((subject) => ({
    subject,
    explanation: explain(policy, toolName, subject, context),
  }));
  const ruled = judged.filter(({ explanation }) =>
    explanation.steps.some((step) => step.reason !== "default"),
  );
  const candidates = ruled.length > 0 ? ruled : judged;
  return candidates.reduce((strictest, next) =>
    STRICTNESS[next.explanation.decision] >
    STRICTNESS[strictest.explanation.decision]
      ? next
      : strictest,
  );
}

/** Builds a {@link PermissionPrompt} that judges each call against the policy. */
export function createPermissionPrompt(
  options: PermissionPromptOptions,
): PermissionPrompt {
  const { loadPolicy, root, context = {}, onAsk } = options;
  return async (request, signal) => {
    const { tool_name: toolName, input } = request;
    const subjects = toolSubjects(toolName, input, root);
    if (subjects === undefined) {
      const field = SUBJECT_FIELDS[toolName.toLowerCase()]?.field;
      return {
        behavior: "deny",
        message: `agent-perms cannot judge ${toolName}: its input has no string "${String(field)}".`,
      };
    }

    const { subject, explanation } = judge(
      await loadPolicy(),
      toolName,
      subjects,
      context,
    );
    switch (explanation.decision) {
      case "allow":
        return { behavior: "allow", updatedInput: input };
      case "deny":
        return {
          behavior: "deny",
          message: `agent-perms denied ${toolName}: ${reasons(explanation, "deny")}.`,
        };
      case "ask":
        if (onAsk === undefined) {
          return {
            behavior: "deny",
            message: `agent-perms needs approval for ${toolName} and no approval handler is configured: ${reasons(explanation, "ask")}.`,
          };
        }
        return onAsk({ request, subject, explanation }, signal);
    }
  };
}

/** The steps that produced `decision`, each as `command (source)`. */
function reasons(
  explanation: Explanation,
  decision: PermissionDecision,
): string {
  return explanation.steps
    .filter((step) => step.decision === decision)
    .map((step) => `${step.command} (${stepSource(step)})`)
    .join("; ");
}

/** A result as an MCP tool returns it: one text block holding the result as JSON. */
export function promptToolContent(result: PermissionPromptResult): {
  content: [{ type: "text"; text: string }];
} {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
