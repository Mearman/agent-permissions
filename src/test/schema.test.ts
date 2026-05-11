import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentPermissionPolicy } from "../schema.ts";

const examplesDir = path.resolve(import.meta.dirname, "../../spec/examples");

void describe("AgentPermissionPolicy", () => {
  void describe("example files", () => {
    for (const file of fs
      .readdirSync(examplesDir)
      .filter((f) => f.endsWith(".json"))) {
      void it(`validates ${file}`, () => {
        const content = fs.readFileSync(path.join(examplesDir, file), "utf-8");
        const data: unknown = JSON.parse(content);
        const result = AgentPermissionPolicy.safeParse(data);
        assert.ok(result.success, `Expected ${file} to validate`);
      });
    }
  });

  void describe("minimal policy", () => {
    void it("accepts an empty object", () => {
      assert.ok(AgentPermissionPolicy.safeParse({}).success);
    });

    void it("accepts only permissions.allow", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          permissions: { allow: ["Read", "Grep"] },
        }).success,
      );
    });

    void it("accepts only permissions.deny", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          permissions: { deny: ["Bash(sudo:*)"] },
        }).success,
      );
    });

    void it("accepts only defaultMode", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({ defaultMode: "readonly" }).success,
      );
    });

    void it("accepts only env", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({ env: { FOO: "bar" } }).success,
      );
    });
  });

  void describe("full policy", () => {
    void it("accepts all fields populated", () => {
      const result = AgentPermissionPolicy.safeParse({
        $schema: "./agent-permissions.schema.json",
        defaultMode: "standard",
        permissions: {
          allow: ["Bash(git status)", "Read"],
          deny: ["Bash(sudo:*)"],
          ask: ["Bash(git push:*)"],
          additionalDirectories: ["../shared-libs/"],
        },
        rules: [
          {
            tool: "Bash",
            pattern: "npm run *",
            tier: "allow",
            when: { cwd: "./packages/*" },
          },
        ],
        profiles: {
          strict: { deny: ["Write", "Edit", "Bash"], allow: ["Read", "Grep"] },
        },
        activeProfile: "strict",
        delegation: {
          maxDepth: 2,
          nonDelegable: ["Bash(sudo:*)"],
          bubbleUp: true,
          agents: {
            review: {
              deny: ["Write", "Edit", "Bash"],
              allow: ["Read", "Grep"],
            },
          },
        },
        sandbox: {
          mode: "workspace-write",
          writableRoots: ["/tmp/build-cache"],
          networkAccess: true,
        },
        network: {
          enabled: true,
          domains: { "api.example.com": "allow", "evil.com": "deny" },
        },
        env: { NODE_ENV: "development" },
      });
      assert.ok(result.success);
    });
  });

  void describe("conditional rules", () => {
    void it("accepts a rule without when", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          rules: [{ tool: "Bash", pattern: "npm run *", tier: "allow" }],
        }).success,
      );
    });

    void it("accepts a rule with partial when (cwd only)", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          rules: [
            {
              tool: "Write",
              pattern: "./config/**",
              tier: "ask",
              when: { cwd: "./packages/*" },
            },
          ],
        }).success,
      );
    });

    void it("accepts a rule with partial when (branch only)", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          rules: [
            {
              tool: "Write",
              pattern: "./config/**",
              tier: "deny",
              when: { branch: "main" },
            },
          ],
        }).success,
      );
    });
  });

  void describe("validation failures", () => {
    void it("rejects unknown permission mode", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({ defaultMode: "yolo" }).success,
      );
    });

    void it("rejects unknown top-level key", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({ unknownField: true }).success,
      );
    });

    void it("rejects non-string permission rules", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({ permissions: { allow: [123] } })
          .success,
      );
    });

    void it("rejects rule without required tool field", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({
          rules: [{ pattern: "npm run *", tier: "allow" }],
        }).success,
      );
    });

    void it("rejects rule with invalid tier", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({
          rules: [{ tool: "Bash", pattern: "npm run *", tier: "maybe" }],
        }).success,
      );
    });

    void it("rejects negative maxDepth", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({ delegation: { maxDepth: -1 } })
          .success,
      );
    });

    void it("rejects non-string env values", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({ env: { PORT: 3000 } }).success,
      );
    });

    void it("rejects unknown sandbox mode", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({ sandbox: { mode: "containerised" } })
          .success,
      );
    });

    void it("rejects unknown keys in sandbox", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({
          sandbox: { mode: "workspace-write", container: "docker" },
        }).success,
      );
    });

    void it("rejects unknown keys in network", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({
          network: { proxy: "http://localhost:8080" },
        }).success,
      );
    });

    void it("rejects invalid domain action", () => {
      assert.ok(
        !AgentPermissionPolicy.safeParse({
          network: { domains: { "example.com": "block" } },
        }).success,
      );
    });
  });

  void describe("sandbox configuration", () => {
    void it("accepts sandbox with mode only", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({ sandbox: { mode: "readonly" } })
          .success,
      );
    });

    void it("accepts sandbox with writableRoots", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          sandbox: {
            mode: "workspace-write",
            writableRoots: ["/tmp/cache", "../libs"],
            networkAccess: false,
          },
        }).success,
      );
    });

    void it("accepts sandbox with networkAccess disabled", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          sandbox: { mode: "full-access", networkAccess: false },
        }).success,
      );
    });
  });

  void describe("named profiles", () => {
    void it("accepts profiles with activeProfile", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          profiles: {
            strict: {
              deny: ["Write", "Edit", "Bash"],
              allow: ["Read", "Grep"],
            },
            relaxed: { allow: ["Read", "Write", "Edit", "Bash(git:*)"] },
          },
          activeProfile: "strict",
        }).success,
      );
    });

    void it("accepts profiles without activeProfile", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          profiles: { default: { allow: ["Read"] } },
        }).success,
      );
    });

    void it("accepts profile with all tier fields", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          profiles: {
            full: {
              allow: ["Read"],
              deny: ["Bash(sudo:*)"],
              ask: ["Bash(git push:*)"],
              additionalDirectories: ["../shared"],
              defaultMode: "standard",
            },
          },
        }).success,
      );
    });
  });

  void describe("network controls", () => {
    void it("accepts network enabled only", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({ network: { enabled: false } })
          .success,
      );
    });

    void it("accepts network with domain rules", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          network: {
            enabled: true,
            domains: { "api.example.com": "allow", "evil.com": "deny" },
          },
        }).success,
      );
    });
  });

  void describe("per-agent delegation overrides", () => {
    void it("accepts delegation with agents", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          delegation: {
            maxDepth: 3,
            agents: {
              review: {
                deny: ["Write", "Edit", "Bash"],
                allow: ["Read", "Grep"],
              },
              docs: {
                allow: ["Read", "Write(./docs/**)", "Bash(mdbook build:*)"],
              },
            },
          },
        }).success,
      );
    });

    void it("accepts empty agents record", () => {
      assert.ok(
        AgentPermissionPolicy.safeParse({
          delegation: { agents: {} },
        }).success,
      );
    });
  });
});
