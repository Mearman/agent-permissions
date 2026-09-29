/**
 * Git remote normalisation, so a `when.remote` pattern compares the same repository whichever way its
 * URL is written.
 */

/**
 * Reduce a git remote to `host/path`, lower case, without scheme, credentials, port, trailing slash
 * or `.git` suffix: `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both become
 * `github.com/org/repo`. A local path keeps its leading slash. Already-normalised input is returned
 * unchanged.
 *
 * Credentials are dropped so a token embedded in a URL never reaches a comparison, a log or a trace.
 */
export function normaliseRemote(remote: string): string {
  let rest = remote.trim();

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    // scheme://[credentials@]host[:port]/path
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? "" : rest.slice(slash);
    const host = authority.slice(authority.lastIndexOf("@") + 1);
    rest = host.replace(/:\d*$/, "") + path;
  } else {
    // scp-like: [credentials@]host:path, but not a Windows drive such as C:\repo
    const scp = /^(?:[^@/:]*@)?([^/:]{2,}):(.+)$/.exec(rest);
    if (scp?.[1] !== undefined && scp[2] !== undefined) {
      rest = `${scp[1]}/${scp[2]}`;
    }
  }

  return rest
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}
