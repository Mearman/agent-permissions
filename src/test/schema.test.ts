import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentPermissionPolicy } from "../schema.ts";

const examplesDir = path.resolve(
  import.meta.dirname,
  "../../spec/examples",
);

describe("agentPermissionPolicy", () => {
  describe("example files", () => {
    for (const file of fs.readdirSync(examplesDir).filter((f) => f.endsWith(".json"))) {
      it(`validates ${file}`, () => {
        const content = fs.readFileSync(path.join(examplesDir, file), "utf-8");
        const data = JSON.parse(content);
        const result = agentPermissionPolicy.safeParse(data);
        expect(result.success).toBe(true);
      });
    }
  });

  describe("minimal policy", () => {
    it("accepts an empty object", () => {
      expect(agentPermissionPolicy.safeParse({}).success).toBe(true);
    });

    it("accepts only permissions.allow", () => {
      expect(
        agentPermissionPolicy.safeParse({
          permissions: { allow: ["Read", "Grep"] },
        }).success,
      ).toBe(true);
    });

    it("accepts only permissions.deny", () => {
      expect(
        agentPermissionPolicy.safeParse({
          permissions: { deny: ["Bash(sudo:*)"] },
        }).success,
      ).toBe(true);
    });

    it("accepts only defaultMode", () => {
      expect(
        agentPermissionPolicy.safeParse({ defaultMode: "readonly" }).success,
      ).toBe(true);
    });

    it("accepts only env", () => {
      expect(
        agentPermissionPolicy.safeParse({ env: { FOO: "bar" } }).success,
      ).toBe(true);
    });
  });

  describe("full policy", () => {
    it("accepts all fields populated", () => {
      const result = agentPermissionPolicy.safeParse({
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
            review: { deny: ["Write", "Edit", "Bash"], allow: ["Read", "Grep"] },
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
      expect(result.success).toBe(true);
    });
  });

  describe("conditional rules", () => {
    it("accepts a rule without when", () => {
      expect(
        agentPermissionPolicy.safeParse({
          rules: [{ tool: "Bash", pattern: "npm run *", tier: "allow" }],
        }).success,
      ).toBe(true);
    });

    it("accepts a rule with partial when (cwd only)", () => {
      expect(
        agentPermissionPolicy.safeParse({
          rules: [
            {
              tool: "Write",
              pattern: "./config/**",
              tier: "ask",
              when: { cwd: "./packages/*" },
            },
          ],
        }).success,
      ).toBe(true);
    });

    it("accepts a rule with partial when (branch only)", () => {
      expect(
        agentPermissionPolicy.safeParse({
          rules: [
            {
              tool: "Write",
              pattern: "./config/**",
              tier: "deny",
              when: { branch: "main" },
            },
          ],
        }).success,
      ).toBe(true);
    });
  });

  describe("validation failures", () => {
    it("rejects unknown permission mode", () => {
      const result = agentPermissionPolicy.safeParse({
        defaultMode: "yolo",
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown top-level key", () => {
      const result = agentPermissionPolicy.safeParse({
        unknownField: true,
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-string permission rules", () => {
      const result = agentPermissionPolicy.safeParse({
        permissions: { allow: [123] },
      });
      expect(result.success).toBe(false);
    });

    it("rejects rule without required tool field", () => {
      const result = agentPermissionPolicy.safeParse({
        rules: [{ pattern: "npm run *", tier: "allow" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects rule with invalid tier", () => {
      const result = agentPermissionPolicy.safeParse({
        rules: [{ tool: "Bash", pattern: "npm run *", tier: "maybe" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative maxDepth", () => {
      const result = agentPermissionPolicy.safeParse({
        delegation: { maxDepth: -1 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-string env values", () => {
      const result = agentPermissionPolicy.safeParse({
        env: { PORT: 3000 },
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown sandbox mode", () => {
      const result = agentPermissionPolicy.safeParse({
        sandbox: { mode: "containerised" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys in sandbox", () => {
      const result = agentPermissionPolicy.safeParse({
        sandbox: { mode: "workspace-write", container: "docker" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown keys in network", () => {
      const result = agentPermissionPolicy.safeParse({
        network: { proxy: "http://localhost:8080" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid domain action", () => {
      const result = agentPermissionPolicy.safeParse({
        network: { domains: { "example.com": "block" } },
      });
      expect(result.success).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // New feature tests
  // -----------------------------------------------------------------------

  describe("sandbox configuration", () => {
    it("accepts sandbox with mode only", () => {
      expect(
        agentPermissionPolicy.safeParse({
          sandbox: { mode: "readonly" },
        }).success,
      ).toBe(true);
    });

    it("accepts sandbox with writableRoots", () => {
      expect(
        agentPermissionPolicy.safeParse({
          sandbox: {
            mode: "workspace-write",
            writableRoots: ["/tmp/cache", "../libs"],
            networkAccess: false,
          },
        }).success,
      ).toBe(true);
    });

    it("accepts sandbox with networkAccess disabled", () => {
      const result = agentPermissionPolicy.safeParse({
        sandbox: { mode: "full-access", networkAccess: false },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("named profiles", () => {
    it("accepts profiles with activeProfile", () => {
      const result = agentPermissionPolicy.safeParse({
        profiles: {
          strict: { deny: ["Write", "Edit", "Bash"], allow: ["Read", "Grep"] },
          relaxed: { allow: ["Read", "Write", "Edit", "Bash(git:*)"] },
        },
        activeProfile: "strict",
      });
      expect(result.success).toBe(true);
    });

    it("accepts profiles without activeProfile", () => {
      expect(
        agentPermissionPolicy.safeParse({
          profiles: {
            default: { allow: ["Read"] },
          },
        }).success,
      ).toBe(true);
    });

    it("accepts profile with all tier fields", () => {
      expect(
        agentPermissionPolicy.safeParse({
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
      ).toBe(true);
    });
  });

  describe("network controls", () => {
    it("accepts network enabled only", () => {
      expect(
        agentPermissionPolicy.safeParse({
          network: { enabled: false },
        }).success,
      ).toBe(true);
    });

    it("accepts network with domain rules", () => {
      expect(
        agentPermissionPolicy.safeParse({
          network: {
            enabled: true,
            domains: { "api.example.com": "allow", "evil.com": "deny" },
          },
        }).success,
      ).toBe(true);
    });
  });

  describe("per-agent delegation overrides", () => {
    it("accepts delegation with agents", () => {
      const result = agentPermissionPolicy.safeParse({
        delegation: {
          maxDepth: 3,
          agents: {
            review: { deny: ["Write", "Edit", "Bash"], allow: ["Read", "Grep"] },
            docs: { allow: ["Read", "Write(./docs/**)", "Bash(mdbook build:*)"] },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts empty agents record", () => {
      expect(
        agentPermissionPolicy.safeParse({
          delegation: { agents: {} },
        }).success,
      ).toBe(true);
    });
  });
});
