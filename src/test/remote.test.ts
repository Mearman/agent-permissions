/** Git remotes are compared in one normalised form: host and path, lower case, no credentials. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normaliseRemote } from "../remote.ts";

void describe("normaliseRemote", () => {
  const cases: [string, string][] = [
    [
      "https://github.com/ExaDev/agent-perms.git",
      "github.com/exadev/agent-perms",
    ],
    ["https://github.com/ExaDev/agent-perms", "github.com/exadev/agent-perms"],
    ["https://github.com/ExaDev/agent-perms/", "github.com/exadev/agent-perms"],
    ["git@github.com:ExaDev/agent-perms.git", "github.com/exadev/agent-perms"],
    [
      "ssh://git@github.com/ExaDev/agent-perms.git",
      "github.com/exadev/agent-perms",
    ],
    [
      "ssh://git@github.com:22/ExaDev/agent-perms.git",
      "github.com/exadev/agent-perms",
    ],
    ["https://user:secret@github.com/o/r.git", "github.com/o/r"],
    ["https://GitHub.COM/o/r", "github.com/o/r"],
    ["git://example.com/o/r.git", "example.com/o/r"],
    ["github.com/o/r", "github.com/o/r"],
    ["github.com/o/r.git", "github.com/o/r"],
    ["/srv/git/repo.git", "/srv/git/repo"],
    ["file:///srv/git/repo.git", "/srv/git/repo"],
  ];
  for (const [remote, expected] of cases) {
    void it(remote, () => {
      assert.equal(normaliseRemote(remote), expected);
    });
  }

  void it("never keeps a credential", () => {
    assert.ok(
      !normaliseRemote("https://user:secret@github.com/o/r.git").includes(
        "secret",
      ),
    );
  });

  void it("is idempotent", () => {
    for (const [remote] of cases) {
      const once = normaliseRemote(remote);
      assert.equal(normaliseRemote(once), once, remote);
    }
  });
});
