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
        delegation: {
          maxDepth: 2,
          nonDelegable: ["Bash(sudo:*)"],
          bubbleUp: true,
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
  });
});
