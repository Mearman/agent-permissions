/** The MCP server exposes the permission-prompt tool only when asked, and answers it with the policy under its root. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, type McpServerOptions } from "../mcp.ts";

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
});
