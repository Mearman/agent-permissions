# MCP server

The MCP sync daemon and the permission-prompt tool.

## MCP sync server

```typescript
import { createMcpServer, startMcpServer } from "agent-perms/mcp";
```

A background sync daemon that keeps native agent config files bidirectionally synced with `.agents/permissions.json`. It exposes no tools unless the permission-prompt mode is on. `startMcpServer(options)` serves on stdio from the current directory and runs the sync; `createMcpServer(root, options)` builds the server without connecting it or syncing, for a host that supplies its own transport. Sync is configured via the `sync` field in the policy file:

```json
{
  "sync": {
    "mode": "watch",
    "backup": true
  }
}
```

- `mode: "sync"`: one-shot sync on startup
- `mode: "watch"`: continuous sync via `fs.watch`
- `mode: false`: disabled

Also available as the `agent-perms-mcp` binary.

## Permission-prompt tool

`agent-perms mcp --permission-prompt` adds one tool, `permission_prompt`, which answers Claude Code's permission prompts from the policy. Claude Code sends prompts to an MCP tool only in print mode (`claude -p`) with `--permission-prompt-tool`; an interactive session asks the person at the terminal and never calls the tool. The tool is consulted only for calls Claude Code would otherwise prompt for: a call its own settings already allow or deny never reaches it.

```bash
claude -p \
  --mcp-config '{"mcpServers":{"agent-perms":{"command":"npx","args":["-y","agent-perms","mcp","--permission-prompt"]}}}' \
  --permission-prompt-tool mcp__agent-perms__permission_prompt \
  "run the tests"
```

Claude Code calls the tool with `{ tool_name, input, tool_use_id }` and reads back one text block holding `{"behavior":"allow","updatedInput":{...}}` or `{"behavior":"deny","message":"..."}`. The tool loads the policy for the server's working directory on every prompt, so edits apply to the next call, and judges the call by one field of its input:

| Tool                                 | Judged by                                                |
| ------------------------------------ | -------------------------------------------------------- |
| `Bash`                               | `command`, split into its commands as in `check`         |
| `Read`, `Write`, `Edit`, `MultiEdit` | `file_path` (see below)                                  |
| `NotebookEdit`                       | `notebook_path` (see below)                              |
| `WebFetch`                           | `url`                                                    |
| `WebSearch`                          | `query`                                                  |
| Any other tool                       | its name alone, so only rules without a pattern match it |

A file path is resolved against the working directory and judged in both forms a policy may write it, absolute (as `confine` writes it) and `./`-relative (as in `./.env`) when it lies inside that directory. The strictest decision any rule reaches in either form wins, and the default mode decides only when neither form matches a rule. A call missing the field its tool is judged by is denied. An `allow` decision returns the input unchanged, and a `deny` returns a message naming the rule and the file it came from. The prompt has no third answer, so an `ask` decision is denied with a message naming the rule that asked, unless an approval handler settles it (below). A prompt carries no cwd or branch, so `when` conditions are unknown: they never allow a call, and may still deny it.

As a library, `createPermissionPrompt` answers prompts directly and takes the approval handler. The handler is where a host puts its own approval flow: showing the request to a person, holding it until someone approves it elsewhere, or consulting another policy. It receives the request, the matched subject and the full explanation, plus an abort signal that fires when the agent abandons the call.

```typescript
import { createPermissionPrompt } from "agent-perms/prompt-tool";
import { loadPolicy } from "agent-perms/loader";

const answer = createPermissionPrompt({
  loadPolicy: () => loadPolicy({ cwd: root }),
  root,
  context: { branch: "main" },
  onAsk: ({ request, subject, explanation }, signal) =>
    approvals.waitFor(request.tool_use_id, subject, explanation, signal),
});

const result = await answer(
  { tool_name: "Bash", input: { command: "git push" } },
  signal,
);
// { behavior: "allow", updatedInput: {...} } or { behavior: "deny", message: "..." }
```

To serve the tool with a handler, pass it to the server: `createMcpServer(root, { permissionPrompt: { onAsk } })`.
