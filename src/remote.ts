/**
 * Git remote normalisation, so a `when.remote` pattern compares the same repository whichever way its URL is written.
 */

/**
 * Reduce a git remote to `host/path`, lower case, without scheme, credentials, port, trailing slash or `.git` suffix: `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both become `github.com/org/repo`. A local path keeps its leading slash. Already-normalised input is returned unchanged.
 *
 * Credentials are dropped so a token embedded in a URL never reaches a comparison, a log or a trace. A remote can carry one in the user information of a `scheme://` URL (everything up to the last `@` of its authority, so an unencoded `@` in a password is not the end of it), in its query or fragment (cut at a literal `?` or `#` only, since an encoded one is part of the path), and in the user information of git's scp-like shorthand (`[user@]host:path`), which a `user:token@host:path` spelling extends with a password. A local path is never read as any of these: the input git itself would take as a path (it has no `scheme://`, and no `:` before its first `/`) keeps every character it has, `@`, `#` and `?` included.
 *
 * Stripping must never change which repository a remote names, so a network remote (any `scheme://` URL except a `file:///` path, and the scp-like shorthand) is unknown when its spelling could reach a repository other than the one its text suggests, or the same repository as another spelling. That is: an empty authority on any scheme but `file`; a host that is missing, is not followed by a numeric port, holds a backslash, a control character or a percent-encoding; a path with a `.` or `..` segment, an empty segment, a control character, a backslash or an `@`; a percent-encoded octet in the path that is malformed or decodes to `/`, `.`, `?`, `#`, `@`, `:`, `\`, `%`, a control character or a letter, digit, `-`, `_` or `~` (those have a plain spelling); and a last segment of `.git`. A host's trailing dot is removed and the host is lower-cased.
 *
 * Never throws. The empty string means the input is unknown in one of those ways. It matches no `when.remote` pattern, and `evaluate` treats it as unknown for `when.remote` and for a predicate's `remote` reference alike.
 */
export function normaliseRemote(remote: string): string {
  const interpreted = interpret(remote.trim());
  if (interpreted === undefined) return "";
  return interpreted
    .toLowerCase()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

/** `host/path` of a `scheme://` URL, a scp-like remote or a local path; undefined when it cannot be read safely. */
function interpret(remote: string): string | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(remote);
  if (scheme?.[1] !== undefined) {
    return fromUrl(scheme[1].toLowerCase(), remote.slice(scheme[0].length));
  }

  // A Windows drive (`C:\repo`, `C:/repo`) is a local path, not a host.
  if (/^[a-z]:[\\/]/iu.test(remote)) return remote;

  // git takes the input as scp-like when a `:` comes before the first `/`.
  const slash = remote.indexOf("/");
  const head = slash === -1 ? remote : remote.slice(0, slash);
  if (!head.includes(":")) return remote;

  // The user information of the shorthand is dropped. A `user:token@host:path` spelling has a `:` before its `@`, which git does not read as user information but which holds a credential, so it is dropped only when a `host:path` follows it: anything else (`host:a@b/c` is a path under `host` for git) cannot be told from a password and is refused.
  const at = head.lastIndexOf("@");
  if (at === -1) return fromScp(remote, false);
  return fromScp(remote.slice(at + 1), head.slice(0, at).includes(":"));
}

/** What follows `scheme://`: `[userinfo@]host[:port][/path][?query][#fragment]`. */
function fromUrl(scheme: string, rest: string): string | undefined {
  const end = rest.search(/[/?#]/u);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const tail = end === -1 ? "" : withoutQueryAndFragment(rest.slice(end));
  if (authority.includes("\\")) return undefined;

  // Only a file URL has no host, and its path is a local path, which is kept as it is.
  if (authority === "") return scheme === "file" ? tail : undefined;

  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const bare = /^(\[[^\]]*\]|[^:[\]]*)(?::(\d*))?$/u.exec(host);
  const name = cleanHost(bare?.[1]);
  if (name === undefined) return undefined;
  const path = checkedPath(tail.slice(1));
  if (path === undefined) return undefined;
  return path === "" ? name : `${name}/${path}`;
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
  const name = cleanHost(host);
  // An absolute path (`host:/srv/repo`) differs from one relative to the home directory (`host:srv/repo`), so its leading slash is kept.
  const absolute = path.startsWith("/");
  const checked = checkedPath(
    withoutQueryAndFragment(absolute ? path.slice(1) : path),
  );
  if (name === undefined || checked === undefined) return undefined;
  return `${name}/${absolute ? "/" : ""}${checked}`;
}

/** The host without a trailing dot, or undefined when it is missing, has an empty label, holds a control character or holds a percent-encoding. */
function cleanHost(host: string | undefined): string | undefined {
  if (host === undefined || host === "") return undefined;
  if (host.includes("%") || hasControl(host, true)) return undefined;
  const name = host.replace(/\.$/u, "");
  // An empty label (`github.com..`, `a..b`) is no host.
  return name === "" || name.includes("..") || name.endsWith(".")
    ? undefined
    : name;
}

/** The bytes a path's percent-encoding may not spell, because the plain character has its own spelling or changes what the path names. */
function isAmbiguousOctet(octet: number): boolean {
  return (
    octet < 0x20 ||
    octet === 0x7f ||
    "/.?#@:\\%-_~".includes(String.fromCharCode(octet)) ||
    /[a-z0-9]/iu.test(String.fromCharCode(octet))
  );
}

/**
 * A network path (without its leading slash) with its trailing slashes removed, or undefined when it names something other than its plain spelling: a `.` or `..` segment, an empty segment, a control character, a backslash, an `@`, an ambiguous or malformed percent-encoding, or a last segment of `.git`.
 */
function checkedPath(path: string): string | undefined {
  const body = path.replace(/\/+$/u, "");
  if (body === "") return "";
  if (/[\\@]/u.test(body) || hasControl(body, false)) return undefined;
  for (const match of body.matchAll(/%(.{0,2})/gu)) {
    const digits = match[1] ?? "";
    if (!/^[0-9a-f]{2}$/iu.test(digits)) return undefined;
    if (isAmbiguousOctet(Number.parseInt(digits, 16))) return undefined;
  }
  const segments = body.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return undefined;
    }
  }
  if (segments[segments.length - 1]?.toLowerCase() === ".git") return undefined;
  return body;
}

/** The text before the first literal `?` or `#`: a query and a fragment can carry a token. An encoded one is path text and stays. */
function withoutQueryAndFragment(text: string): string {
  const cut = text.search(/[?#]/u);
  return cut === -1 ? text : text.slice(0, cut);
}

/** Whether `text` holds a control character, or a space when `space` is set. */
function hasControl(text: string, space: boolean): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || (space && code === 0x20)) return true;
  }
  return false;
}
