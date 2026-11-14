/**
 * Git remote normalisation, so a `when.remote` pattern compares the same repository whichever way its
 * URL is written.
 */

/**
 * Reduce a git remote to `host/path`, lower case, without scheme, credentials, port, trailing slash or `.git` suffix: `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both become `github.com/org/repo`. A local path keeps its leading slash. Already-normalised input is returned unchanged.
 *
 * Credentials are dropped so a token embedded in a URL never reaches a comparison, a log or a trace: the user information of a `scheme://` URL (everything up to its last `@`, so an unencoded `@` inside a password does not leak into the host), its query and fragment, and the `user@` of git's scp-like shorthand (`[user@]host:path`, per git's own "GIT URLS" documentation, which gives no password syntax for that shorthand). A form this cannot clean, because it carries what looks like a password somewhere other than those two places, is refused rather than passed through with the password still in it: the caller sees that the remote did not normalise, not a value that still holds it.
 *
 * @throws Error when the input is not a form this function can both parse and clear of credentials.
 *   The message never repeats the input, so the credential it was refused for does not itself reach
 *   whatever reads the thrown error.
 */
export function normaliseRemote(remote: string): string {
  let rest = remote.trim().replace(/[?#].*$/su, "");
  const refuse = (): never => {
    throw new Error(
      "normaliseRemote: not a remote it can clear of credentials",
    );
  };

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? "" : rest.slice(slash);
    const at = authority.lastIndexOf("@");
    // An authority with a userinfo marker but nothing after it names no host, which this function cannot clean to anything meaningful; an authority that is empty outright (file:///path) is a local path with no host at all, and is left as the path.
    if (at !== -1 && at === authority.length - 1) refuse();
    const host = at === -1 ? authority : authority.slice(at + 1);
    rest = host.replace(/:\d*$/u, "") + path;
  } else {
    const at = rest.indexOf("@");
    let candidate = rest;
    if (at !== -1) {
      const userinfo = rest.slice(0, at);
      // A clean scp username has no ':' or '/' in it; anything else (a password, a misplaced userinfo later in the string) is not the shorthand git documents, so it is refused.
      if (userinfo === "" || /[:/]/u.test(userinfo)) refuse();
      candidate = rest.slice(at + 1);
    }
    const scp = /^([^@/:]{2,}):(.+)$/u.exec(candidate);
    const [, host, path] = scp ?? [];
    rest =
      host !== undefined && path !== undefined ? `${host}/${path}` : candidate;
  }

  // Defence in depth: a result that still holds an '@' means something upstream failed to clear a credential rather than that this is a legitimate git remote, since none of the forms above ever leave one in what they return.
  if (rest.includes("@")) refuse();

  return rest
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .toLowerCase();
}
