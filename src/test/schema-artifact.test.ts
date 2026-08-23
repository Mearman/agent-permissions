import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod";
import { describe, it } from "node:test";
import { AgentPermissionPolicy } from "../schema.ts";

const artifact = path.resolve(
  import.meta.dirname,
  "../../agent-permissions.schema.json",
);

// Mirrors the generation in tsdown.config.ts's zodSchemaPlugin: same zod call, same $id/$schema envelope, so the committed artifact is held against what the current schema source would produce — a stale committed schema (a src/schema.ts edit committed without a rebuild) fails here rather than shipping to users' $schema URLs.
function generateExpected(): unknown {
  const jsonSchema = z.toJSONSchema(AgentPermissionPolicy, {
    target: "draft-07",
  });
  const REPO_RAW_BASE =
    "https://raw.githubusercontent.com/Mearman/agent-permissions/main";
  return {
    $id: `${REPO_RAW_BASE}/agent-permissions.schema.json`,
    $schema: "http://json-schema.org/draft-07/schema#",
    ...jsonSchema,
  };
}

void describe("committed agent-permissions.schema.json", () => {
  void it("parses as JSON", () => {
    const raw: unknown = JSON.parse(fs.readFileSync(artifact, "utf-8"));
    assert.equal(typeof raw, "object");
  });

  void it("matches the schema source (deep equality, not formatting)", () => {
    const committed: unknown = JSON.parse(fs.readFileSync(artifact, "utf-8"));
    const expected = generateExpected();
    assert.deepEqual(committed, expected);
  });
});
