/** The permission-prompt handler judges a host's tool call against the policy and answers in the host's result shape. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PermissionPolicy } from "../evaluate.ts";
import {
  createPermissionPrompt,
  promptToolContent,
  toolSubject,
  type AskHandler,
  type PermissionPromptResult,
} from "../prompt-tool.ts";

const root = "/work/project";

const policy: PermissionPolicy = {
  defaultMode: "standard",
  rules: [
    { tool: "Bash", pattern: "sudo:*", tier: "deny" },
    { tool: "Bash", pattern: "git push:*", tier: "ask" },
    { tool: "Bash", pattern: "git:*", tier: "allow" },
    { tool: "Read", pattern: "./.env", tier: "deny" },
    { tool: "Read", tier: "allow" },
    {
      tool: "Bash",
      pattern: "npm publish:*",
      tier: "allow",
      when: { branch: "main" },
    },
  ],
};

const prompt = (onAsk?: AskHandler) =>
  createPermissionPrompt({
    loadPolicy: () => Promise.resolve(policy),
    root,
    ...(onAsk === undefined ? {} : { onAsk }),
  });

const signal = new AbortController().signal;

void describe("toolSubject", () => {
  void it("judges a shell call by its command", () => {
    assert.equal(
      toolSubject("Bash", { command: "git status" }, root),
      "git status",
    );
  });

  void it("judges a file inside the root by its root-relative path", () => {
    assert.equal(
      toolSubject("Read", { file_path: "/work/project/src/a.ts" }, root),
      "./src/a.ts",
    );
  });

  void it("keeps a file outside the root absolute", () => {
    assert.equal(
      toolSubject("Read", { file_path: "/etc/hosts" }, root),
      "/etc/hosts",
    );
  });

  void it("judges a fetch by its URL", () => {
    assert.equal(
      toolSubject("WebFetch", { url: "https://example.com/a" }, root),
      "https://example.com/a",
    );
  });

  void it("judges a tool with no subject field by its name alone", () => {
    assert.equal(
      toolSubject("mcp__github__list_prs", { owner: "o" }, root),
      "",
    );
  });

  void it("has no subject when the field the tool is judged by is missing", () => {
    assert.equal(toolSubject("Bash", { description: "x" }, root), undefined);
  });
});

void describe("createPermissionPrompt", () => {
  void it("allows a call the policy allows, echoing its input", async () => {
    const input = { command: "git status", description: "status" };
    const result = await prompt()({ tool_name: "Bash", input }, signal);
    assert.deepEqual(result, { behavior: "allow", updatedInput: input });
  });

  void it("denies a call the policy denies, naming the rule", async () => {
    const result = await prompt()(
      { tool_name: "Bash", input: { command: "sudo rm -rf /" } },
      signal,
    );
    assert.equal(result.behavior, "deny");
    assert.match(result.message, /sudo rm -rf \/.*Bash\(sudo:\*\) \[deny\]/);
  });

  void it("denies a file the policy denies by its root-relative path", async () => {
    const result = await prompt()(
      { tool_name: "Read", input: { file_path: "/work/project/.env" } },
      signal,
    );
    assert.equal(result.behavior, "deny");
  });

  void it("denies a call whose subject field is missing", async () => {
    const result = await prompt()(
      { tool_name: "Bash", input: { description: "no command" } },
      signal,
    );
    assert.equal(result.behavior, "deny");
    assert.match(result.message, /command/);
  });

  void it("never lets an unknown condition allow a call", async () => {
    const result = await prompt()(
      { tool_name: "Bash", input: { command: "npm publish --tag next" } },
      signal,
    );
    assert.equal(result.behavior, "deny");
  });

  void it("denies an ask decision when the host has no approval handler", async () => {
    const result = await prompt()(
      { tool_name: "Bash", input: { command: "git push origin main" } },
      signal,
    );
    assert.equal(result.behavior, "deny");
    assert.match(result.message, /approval.*Bash\(git push:\*\) \[ask\]/);
  });

  void it("hands an ask decision to the host and returns its verdict", async () => {
    const seen: string[] = [];
    const verdict: PermissionPromptResult = {
      behavior: "allow",
      updatedInput: { command: "git push origin feature" },
    };
    const onAsk: AskHandler = (ask) => {
      seen.push(
        `${ask.request.tool_name} ${ask.subject} ${ask.explanation.decision}`,
      );
      return Promise.resolve(verdict);
    };
    const result = await prompt(onAsk)(
      {
        tool_name: "Bash",
        input: { command: "git push origin main" },
        tool_use_id: "toolu_1",
      },
      signal,
    );
    assert.deepEqual(result, verdict);
    assert.deepEqual(seen, ["Bash git push origin main ask"]);
  });

  void it("does not consult the host for a call the policy settles", async () => {
    let asked = false;
    const onAsk: AskHandler = () => {
      asked = true;
      return Promise.resolve({ behavior: "deny", message: "no" });
    };
    const result = await prompt(onAsk)(
      { tool_name: "Bash", input: { command: "git status" } },
      signal,
    );
    assert.equal(result.behavior, "allow");
    assert.equal(asked, false);
  });
});

void describe("promptToolContent", () => {
  void it("wraps the result as one JSON text block", () => {
    const result: PermissionPromptResult = { behavior: "deny", message: "no" };
    assert.deepEqual(promptToolContent(result), {
      content: [{ type: "text", text: '{"behavior":"deny","message":"no"}' }],
    });
  });
});
