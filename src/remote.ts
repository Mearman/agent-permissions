/**
 * Git remote normalisation, so a `when.remote` pattern compares the same repository whichever way its URL is written.
 */

/**
 * Reduce a git remote to `host/path`, lower case, without scheme, credentials, port, trailing slash or `.git` suffix: `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both become `github.com/org/repo`. A local path keeps its leading slash. Already-normalised input is returned unchanged.
 *
 * Credentials are dropped so a token embedded in a URL never reaches a comparison, a log or a trace. A remote can carry one in the user information of a `scheme://` URL (everything up to the last `@` of its authority, so an unencoded `@` in a password is not the end of it), in its query or fragment, and in the user information of git's scp-like shorthand (`[user@]host:path`), which a `user:token@host:path` spelling extends with a password. A local path is never read as any of these: the input git itself would take as a path (it has no `scheme://`, and no `:` before its first `/`) keeps every character it has, `@`, `#` and `?` included.
 *
 * Never throws. The empty string means the input is not a remote this function can interpret without risking a credential in its result: an authority holding a backslash (which parsers read differently), a port that is not a number (a password containing `/`, `?` or `#` reads that way), a host that is missing, or a network form whose path holds an `@`. An empty result matches no `when.remote` pattern, and a predicate's `remote` reference is unknown for it.
 */
export function normaliseRemote(remote: string): string {
  const interpreted = interpret(remote.trim());
  if (interpreted === undefined) return "";
  return interpreted
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .toLowerCase();
}

/** `host/path` of a `scheme://` URL, a scp-like remote or a local path; undefined when it cannot be read safely. */
function interpret(remote: string): string | undefined {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(remote);
  if (scheme) return fromUrl(remote.slice(scheme[0].length));

  // A Windows drive (`C:\repo`, `C:/repo`) is a local path, not a host.
  if (/^[a-z]:[\\/]/iu.test(remote)) return remote;

  // git takes the input as scp-like when a `:` comes before the first `/`.
  const slash = remote.indexOf("/");
  const head = slash === -1 ? remote : remote.slice(0, slash);
  if (!head.includes(":")) return remote;

  // The user information of the shorthand is dropped. A `user:token@host:path` spelling has a `:`
  // before its `@`, which git does not read as user information but which holds a credential, so it
  // is dropped only when a `host:path` follows it: anything else (`host:a@b/c` is a path under
  // `host` for git) cannot be told from a password and is refused.
  const at = head.lastIndexOf("@");
  if (at === -1) return fromScp(remote, false);
  return fromScp(remote.slice(at + 1), head.slice(0, at).includes(":"));
}

/** What follows `scheme://`: `[userinfo@]host[:port][/path][?query][#fragment]`. */
function fromUrl(rest: string): string | undefined {
  const end = rest.search(/[/?#]/u);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const tail = end === -1 ? "" : withoutQueryAndFragment(rest.slice(end));
  if (authority.includes("\\")) return undefined;

  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const bare = /^(\[[^\]]*\]|[^:[\]]*)(?::(\d*))?$/u.exec(host);
  const name = bare?.[1];
  // An empty authority (`file:///path`) names no host and leaves the path as it is.
  if (name === undefined || (name === "" && authority !== "")) return undefined;
  // A `@` in the path of a network URL is where a stray credential ends up, and a file URL (no host) is a local path.
  if (authority !== "" && tail.includes("@")) return undefined;
  return name + tail;
}

/** `host:path` of the scp-like shorthand, with its user information already removed; `strict` refuses what is not that shape. */
function fromScp(rest: string, strict: boolean): string | undefined {
  const bracketed = /^(\[[^\]]*\]):(.*)$/su.exec(rest);
  const split = bracketed ?? /^([^:/]*):(.*)$/su.exec(rest);
  const [, host, path] = split ?? [];
  // A one-letter host is a Windows drive, never a host.
  if (host === undefined || path === undefined || host.length < 2) {
    return strict ? undefined : rest;
  }
  const clean = withoutQueryAndFragment(path);
  if (clean.includes("@")) return undefined;
  return `${host}/${clean}`;
}

/** The text before the first `?` or `#`, or their percent-encoded spellings: a query and a fragment can carry a token. */
function withoutQueryAndFragment(text: string): string {
  const cut = text.search(/[?#]|%3f|%23/iu);
  return cut === -1 ? text : text.slice(0, cut);
}
