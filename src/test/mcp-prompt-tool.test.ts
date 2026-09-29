/** The MCP server exposes the permission-prompt tool only when asked, and answers it with the policy under its root. */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, type McpServerOptions } from "../mcp.ts";

const CLI = join(import.meta.dirname, "..", "cli.ts");

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "agent-perms-prompt-"));
  mkdirSync(join(root, ".agents"));
  writeFileSync(
    join(root, ".agents", "permissions.json"),
    JSON.stringify({
      defaultMode: "standard",
      rules: [
        { tool: "Bash", pattern: "sudo:*", tier: "deny" },
        { tool: "Bash", pattern: "git:*", tier: "allow" },
      ],
    }),
  );
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Connect a client to an in-process server for `root`. */
async function connect(options: McpServerOptions): Promise<Client> {
  const server = createMcpServer(root, options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

/** Connect a client to the CLI's `mcp` command, spawned in `root`. */
async function connectCli(flags: string[]): Promise<Client> {
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--experimental-strip-types", CLI, "mcp", ...flags],
      cwd: root,
      stderr: "ignore",
    }),
  );
  return client;
}

/** Run `body` against a client and close it afterwards, even when an assertion fails, so a spawned server never outlives its test. */
async function withClient(
  connecting: Promise<Client>,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const client = await connecting;
  try {
    await body(client);
  } finally {
    await client.close();
  }
}

/** The text of the single content block a tool call returned. */
function onlyText(result: unknown): string {
  assert.ok(
    typeof result === "object" && result !== null && "content" in result,
  );
  const content: unknown = result.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 1);
  const block: unknown = content[0];
  assert.ok(typeof block === "object" && block !== null);
  assert.ok("type" in block && block.type === "text");
  assert.ok("text" in block && typeof block.text === "string");
  return block.text;
}

void describe("MCP permission-prompt tool", () => {
  void it("is not exposed unless the prompt mode is on", () =>
    withClient(connect({}), (client) => {
      assert.equal(client.getServerCapabilities()?.tools, undefined);
      return Promise.resolve();
    }));

  void it("is exposed as permission_prompt when the prompt mode is on", () =>
    withClient(connect({ permissionPrompt: {} }), async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ["permission_prompt"],
      );
    }));

  void it("answers an allowed call with an allow result echoing the input", () =>
    withClient(connect({ permissionPrompt: {} }), async (client) => {
      const input = { command: "git status" };
      const result = await client.callTool({
        name: "permission_prompt",
        arguments: { tool_name: "Bash", input, tool_use_id: "toolu_1" },
      });
      assert.deepEqual(JSON.parse(onlyText(result)), {
        behavior: "allow",
        updatedInput: input,
      });
    }));

  void it("answers a denied call with a deny result and a message", () =>
    withClient(connect({ permissionPrompt: {} }), async (client) => {
      const result = await client.callTool({
        name: "permission_prompt",
        arguments: { tool_name: "Bash", input: { command: "sudo ls" } },
      });
      const parsed: unknown = JSON.parse(onlyText(result));
      assert.ok(typeof parsed === "object" && parsed !== null);
      assert.ok("behavior" in parsed && parsed.behavior === "deny");
      assert.ok("message" in parsed && typeof parsed.message === "string");
      assert.match(parsed.message, /Bash\(sudo:\*\) \[deny\]/);
    }));

  void it("hands an ask decision to the host's handler", () =>
    withClient(
      connect({
        permissionPrompt: {
          onAsk: (ask) =>
            Promise.resolve({
              behavior: "deny",
              message: `host declined ${ask.subject}`,
            }),
        },
      }),
      async (client) => {
        const result = await client.callTool({
          name: "permission_prompt",
          arguments: { tool_name: "Bash", input: { command: "npm install" } },
        });
        assert.deepEqual(JSON.parse(onlyText(result)), {
          behavior: "deny",
          message: "host declined npm install",
        });
      },
    ));

  void it("is served over stdio by `agent-perms mcp --permission-prompt`", () =>
    withClient(connectCli(["--permission-prompt"]), async (client) => {
      const result = await client.callTool({
        name: "permission_prompt",
        arguments: { tool_name: "Bash", input: { command: "git log" } },
      });
      assert.deepEqual(JSON.parse(onlyText(result)), {
        behavior: "allow",
        updatedInput: { command: "git log" },
      });
    }));

  void it("is not served by `agent-perms mcp` without the flag", () =>
    withClient(connectCli([]), (client) => {
      assert.equal(client.getServerCapabilities()?.tools, undefined);
      return Promise.resolve();
    }));
});
