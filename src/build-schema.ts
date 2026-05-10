/**
 * Compile the Zod schema to JSON Schema (draft-07) for SchemaStore / IDE use.
 *
 * Usage: node --experimental-strip-types src/build-schema.ts
 * Or:    pnpm build:schema
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod";
import { agentPermissionPolicy } from "./schema.ts";

const outPath = path.resolve(
  import.meta.dirname,
  "..",
  "agent-permissions.schema.json",
);

const jsonSchema = z.toJSONSchema(agentPermissionPolicy, {
  target: "draft-07",
});

// TODO: Update $id to the canonical URL once the schema is published
// (SchemaStore or GitHub Pages). The repo raw URL will be the initial target.
// Replace 'YOUR-ORG' with the actual GitHub org/username.
const REPO_RAW_BASE =
  "https://raw.githubusercontent.com/YOUR-ORG/agent-permissions-spec/main";

const output = {
  $id: `${REPO_RAW_BASE}/agent-permissions.schema.json`,
  $schema: "http://json-schema.org/draft-07/schema#",
  ...jsonSchema,
};

fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`✓ Compiled to ${outPath}`);
