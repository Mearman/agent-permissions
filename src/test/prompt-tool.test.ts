/** The permission-prompt handler judges a host's tool call against the policy and answers in the host's result shape. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PermissionPolicy } from "../evaluate.ts";
import {
  createPermissionPrompt,
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

  void it("applies a file rule written as an absolute path", async () => {
    const absolute = createPermissionPrompt({
      loadPolicy: () =>
        Promise.resolve({
          defaultMode: "restricted",
          rules: [{ tool: "Edit", pattern: "/work/project/*", tier: "allow" }],
        }),
      root,
    });
    const result = await absolute(
      { tool_name: "Edit", input: { file_path: "/work/project/src/a.ts" } },
      signal,
    );
    assert.equal(result.behavior, "allow");
  });

  void it("lets a rule on either path form deny what the other allows", async () => {
    const mixed = createPermissionPrompt({
      loadPolicy: () =>
        Promise.resolve({
          defaultMode: "standard",
          rules: [
            { tool: "Read", pattern: "/work/project/*", tier: "allow" },
            { tool: "Read", pattern: "./secrets/*", tier: "deny" },
          ],
        }),
      root,
    });
    const result = await mixed(
      { tool_name: "Read", input: { file_path: "/work/project/secrets/key" } },
      signal,
    );
    assert.equal(result.behavior, "deny");
    assert.match(
      result.message,
      /\.\/secrets\/key \(Read\(\.\/secrets\/\*\) \[deny\]\)/,
    );
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
