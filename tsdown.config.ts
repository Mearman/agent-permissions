import { defineConfig } from "tsdown";
import * as fs from "node:fs";
import * as path from "node:path";
import * as z from "zod";
import { agentPermissionPolicy } from "./src/schema.ts";

/**
 * Rolldown plugin that compiles the Zod schema to JSON Schema after build.
 * Replaces the separate `build-schema.ts` script.
 */
function zodSchemaPlugin() {
  let written = false;
  return {
    name: "zod-schema",
    writeBundle() {
      if (written) return;
      written = true;

      const outPath = path.resolve("agent-permissions.schema.json");

      const jsonSchema = z.toJSONSchema(agentPermissionPolicy, {
        target: "draft-07",
      });

      const REPO_RAW_BASE =
        "https://raw.githubusercontent.com/Mearman/agent-permissions/main";

      const output = {
        $id: `${REPO_RAW_BASE}/agent-permissions.schema.json`,
        $schema: "http://json-schema.org/draft-07/schema#",
        ...jsonSchema,
      };

      fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
      console.log(`✓ Compiled to ${outPath}`);
    },
  };
}

export default defineConfig({
  entry: {
    index: "src/index.ts",
    schema: "src/schema.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  treeshake: true,
  target: "es2022",
  plugins: [zodSchemaPlugin()],
});
