/** The release notes generator can render the notes the release configuration asks for. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import config, { commitTypes } from "../../release.config.ts";

const notesPluginName = "@semantic-release/release-notes-generator";

interface NotesPlugin {
  generateNotes: (pluginConfig: unknown, context: unknown) => Promise<string>;
}

function isNotesPlugin(value: unknown): value is NotesPlugin {
  return (
    typeof value === "object" &&
    value !== null &&
    "generateNotes" in value &&
    typeof value.generateNotes === "function"
  );
}

/** Resolve the notes plugin the way semantic-release does, from semantic-release's own dependencies. */
async function loadNotesPlugin(): Promise<NotesPlugin> {
  const semanticRelease = createRequire(import.meta.url).resolve(
    "semantic-release",
  );
  const resolved = createRequire(semanticRelease).resolve(notesPluginName);
  const loaded: unknown = await import(pathToFileURL(resolved).href);
  assert.ok(isNotesPlugin(loaded), "the notes plugin exports generateNotes");
  return loaded;
}

const noop = (): void => undefined;

function notesPluginConfig(): unknown {
  for (const plugin of config.plugins) {
    if (Array.isArray(plugin) && plugin[0] === notesPluginName)
      return plugin[1];
  }
  throw new Error(`${notesPluginName} is not configured`);
}

void describe("release notes", () => {
  void it("render a section for every configured commit type that appears", async () => {
    const { generateNotes } = await loadNotesPlugin();
    const commits = commitTypes.map((t, index) => ({
      hash: index.toString(16).padStart(40, "0"),
      message: `${t.type}: describe the ${t.type} change`,
      committerDate: "2026-01-01T00:00:00.000Z",
    }));
    const notes = await generateNotes(notesPluginConfig(), {
      cwd: process.cwd(),
      options: { repositoryUrl: "https://example.com/owner/repo.git" },
      commits,
      lastRelease: { gitTag: "v1.0.0" },
      nextRelease: { gitTag: "v1.1.0", version: "1.1.0" },
      logger: { log: noop, error: noop },
    });
    for (const t of commitTypes) {
      assert.ok(notes.includes(`### ${t.section}`), `a "${t.section}" section`);
      assert.ok(notes.includes(`describe the ${t.type} change`), t.type);
    }
  });
});
