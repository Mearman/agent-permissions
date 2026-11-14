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

void describe("normaliseRemote credentials", () => {
  const cleared: [string, string][] = [
    ["https://user:SEKRET@github.com/o/r.git", "github.com/o/r"],
    ["https://SEKRET@github.com/o/r", "github.com/o/r"],
    ["https://:SEKRET@github.com/o/r", "github.com/o/r"],
    ["https://user:p@SEKRET@github.com/o/r", "github.com/o/r"],
    ["https://user%2Fname:SEKRET@github.com/o/r", "github.com/o/r"],
    ["https://user%40example.com:SEKRET@github.com/o/r", "github.com/o/r"],
    ["git+https://user:SEKRET@github.com/o/r", "github.com/o/r"],
    ["ssh://git:SEKRET@github.com:22/o/r.git", "github.com/o/r"],
    ["file://user:SEKRET@host/p", "host/p"],
    ["https://github.com/o/r.git?token=SEKRET", "github.com/o/r"],
    ["https://github.com/o/r.git#SEKRET", "github.com/o/r"],
    ["https://github.com/o/r?a=1#SEKRET", "github.com/o/r"],
    ["https://github.com:443?token=SEKRET", "github.com"],
    ["ssh://git@github.com:22/o/r.git?token=SEKRET", "github.com/o/r"],
    ["git@github.com:o/r.git?token=SEKRET", "github.com/o/r"],
    ["git@github.com:o/r.git#SEKRET", "github.com/o/r"],
    ["user:SEKRET@github.com:o/r.git", "github.com/o/r"],
    ["user:p@SEKRET@github.com:o/r.git", "github.com/o/r"],
    [":SEKRET@github.com:o/r.git", "github.com/o/r"],
    ["git@[::1]:o/r.git", "[::1]/o/r"],
    ["ssh://git@[::1]:22/o/r.git", "[::1]/o/r"],
  ];

  for (const [remote, expected] of cleared) {
    void it(`clears ${remote}`, () => {
      const normalised = normaliseRemote(remote);
      assert.equal(normalised, expected);
      assert.ok(!normalised.toLowerCase().includes("sekret"));
      assert.equal(normaliseRemote(normalised), normalised, "idempotent");
    });
  }

  // A credential in any of these cannot be told from a path, a host or a port, so none is returned.
  const refused = [
    "https://github.com\\@SEKRET/o/r",
    "https://user:p/ss@github.com/o/r",
    "https://user:p?ss@github.com/o/r",
    "https://user:p#ss@github.com/o/r",
    "https://user@",
    "https://:22/o/r",
    "https:/user:SEKRET@github.com/o/r",
    "https://github.com/x-access-token:SEKRET@/o/r",
    "user:p/ss@github.com:o/r",
    "user:SEKRET@github.com/o/r",
    "host:a@b/x",
  ];

  for (const remote of refused) {
    void it(`refuses ${remote} without throwing and without returning a credential`, () => {
      assert.equal(normaliseRemote(remote), "");
    });
  }
});

/** Spellings that reach the same repository as `https://github.com/o/r`, and ones that could reach another. */
const PLAIN = "github.com/o/r";
const SAME_AS_PLAIN = [
  "https://github.com/o/r",
  "https://GitHub.COM/o/r",
  "https://github.com./o/r",
  "https://github.com/o/r/",
  "https://github.com/o/r.git",
  "https://github.com/o/r.GIT",
  "https://github.com/o/r.git/",
  "https://github.com:443/o/r",
  "https://u:SEKRET@github.com/o/r",
  "ssh://git@github.com./o/r.git",
  "git@github.com:o/r.git",
  "git@github.com.:o/r",
  "github.com:o/r",
];
const UNKNOWN = [
  // an empty authority on a network scheme, with and without user information in the path
  "https:///github.com/o/r",
  "https:///u:SEKRET@github.com/o/r",
  "https:///SEKRET@github.com/o/r",
  "ssh:///git:SEKRET@github.com/o/r",
  "git:///github.com/o/r",
  "git+ssh:///github.com/o/r",
  "http:///github.com/o/r",
  // a path that leaves its owner or names another spelling of the same repository
  "https://github.com/o/x%23/../../other/r",
  "https://github.com/o/x%3f/../../other/r",
  "https://github.com/o/x%2F../../other/r",
  "https://github.com/o/r%3Ftoken=SEKRET",
  "https://github.com/o/r%23SEKRET",
  "https://github.com/o/./r",
  "https://github.com/o/../o/r",
  "https://github.com/o//r",
  "https://github.com//o/r",
  "https://github.com/o/r/.git",
  "https://github.com/o/r/./",
  "https://github.com/o/%2e%2e/o/r",
  "https://github.com/o/%2E/r",
  "https://github.com/o%2Fx/r",
  "https://github.com/o/r%5Cx",
  "https://github.com/o/r%40x",
  "https://github.com/o/r%3Ax",
  "https://github.com/o/r%25",
  "https://github.com/o/%72",
  "https://github.com/%6F/r",
  "https://github.com/o/r%00",
  "https://github.com/o/r%",
  "https://github.com/o/r%zz",
  "https://github.com/o/r\u0001",
  "https://github.com/o\\r",
  "https://github.com/o/r@v1",
  // a host that is spelled another way
  "https://%67ithub.com/o/r",
  "https://github.com%2e/o/r",
  "https://github.com\\@other.example/o/r",
  "https://github.com../o/r",
  // the scp-like shorthand, read the same way
  "git@github.com:o/x%23/../../other/r",
  "git@github.com:o/./r",
  "git@github.com:o//r",
  "git@github.com:o/r/.git",
  "git@github.com:o/%72",
  "git@%67ithub.com:o/r",
];

void describe("normaliseRemote spellings of one repository", () => {
  for (const remote of SAME_AS_PLAIN) {
    void it(`reads ${remote} as ${PLAIN}`, () => {
      assert.equal(normaliseRemote(remote), PLAIN);
    });
  }

  for (const remote of UNKNOWN) {
    void it(`is unknown for ${JSON.stringify(remote)}`, () => {
      assert.equal(normaliseRemote(remote), "");
    });
  }

  void it("keeps an encoded character that has no other spelling", () => {
    assert.equal(
      normaliseRemote("https://github.com/o/caf%C3%A9%20x"),
      "github.com/o/caf%c3%a9%20x",
    );
  });

  void it("keeps the leading slash of an absolute scp path, which names another path than a relative one", () => {
    assert.equal(
      normaliseRemote("git@host.example:/srv/git/r.git"),
      "host.example//srv/git/r",
    );
    assert.equal(
      normaliseRemote("git@host.example:srv/git/r.git"),
      "host.example/srv/git/r",
    );
  });

  void it("keeps a file URL path as a local path", () => {
    assert.equal(
      normaliseRemote("file:///srv/git/a@b/repo.git"),
      "/srv/git/a@b/repo",
    );
  });
});

void describe("normaliseRemote local paths", () => {
  // Input git takes as a path is a path: `@`, `#` and `?` in it are characters, not credentials.
  const paths: [string, string][] = [
    ["/srv/git/a@b/repo.git", "/srv/git/a@b/repo"],
    ["/srv/git/my#repo.git", "/srv/git/my#repo"],
    ["/srv/git/my?repo.git", "/srv/git/my?repo"],
    ["./a@b/c#d?e", "./a@b/c#d?e"],
    ["../x@y", "../x@y"],
    ["~/a@b/repo.git", "~/a@b/repo"],
    ["a@b/repo", "a@b/repo"],
    ["C:\\Repo", "c:\\repo"],
    ["C:/Repo@x#y", "c:/repo@x#y"],
    ["\\\\Server\\Share@x\\Repo", "\\\\server\\share@x\\repo"],
    ["file:///srv/git/a@b/repo.git", "/srv/git/a@b/repo"],
  ];

  for (const [path, expected] of paths) {
    void it(`keeps ${path} as a path`, () => {
      assert.equal(normaliseRemote(path), expected);
    });
  }
});
