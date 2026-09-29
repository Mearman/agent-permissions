/**
 * Builders for synthetic session transcripts in the JSON Lines shape the parser reads: one `assistant` entry per `tool_use` block and one `user` entry per `tool_result` block, each carrying the working directory and branch it was recorded in. Every value here is made up.
 */

/** The result text the harness records when a permission rule denied a call. */
export function deniedText(tool: string, command: string): string {
  return `Permission to use ${tool} with command ${command} has been denied.`;
}

/** The result text the harness records when the user declined a call they were asked about. */
export const REJECTED_TEXT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

interface Where {
  cwd?: string;
  gitBranch?: string;
}

const HERE: Where = { cwd: "/work/example", gitBranch: "main" };

/** An assistant entry holding one tool call. */
export function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  where: Where = HERE,
): Record<string, unknown> {
  return {
    type: "assistant",
    ...where,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  };
}

/** A user entry holding the result of one tool call. */
export function toolResult(
  id: string,
  content: string | { type: "text"; text: string }[],
  isError = false,
  where: Where = HERE,
): Record<string, unknown> {
  return {
    type: "user",
    ...where,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  };
}

/** A Bash call and its recorded outcome: run, denied by a rule, or declined by the user. */
export function bash(
  id: string,
  command: string,
  outcome: "ran" | "denied" | "rejected",
  where: Where = HERE,
): Record<string, unknown>[] {
  const call = toolUse(id, "Bash", { command, description: "d" }, where);
  switch (outcome) {
    case "ran":
      return [call, toolResult(id, "ok", false, where)];
    case "denied":
      return [call, toolResult(id, deniedText("Bash", command), true, where)];
    case "rejected":
      return [call, toolResult(id, REJECTED_TEXT, true, where)];
  }
}

/** Serialise entries as a JSON Lines transcript. */
export function jsonl(entries: Record<string, unknown>[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}
