/**
 * The error `sync` rejects with when it refuses to touch a file, so a caller can tell a refusal
 * (nothing was written because of a named file) from a failure while writing.
 */

/** Why a file was refused. */
export type SyncRefusalReason =
  /** The file exists and cannot be read (a permission error, a directory, an I/O error). */
  | "unreadable"
  /** The file's bytes are not valid UTF-8, so rewriting them would change bytes sync does not own. */
  | "not-utf8"
  /** The file is not valid for its agent, for example malformed JSON, or comments in strict JSON. */
  | "invalid-format"
  /**
   * A path sync would edit occurs more than once in the file, so the agent would read a different
   * occurrence than the edit changes.
   */
  | "duplicate-key"
  /** The file's top level is not an object (or a mapping, for YAML). */
  | "not-an-object"
  /** A value the agent's codec models could not be decoded, so writing would replace it unread. */
  | "undecodable"
  /** The file changed after sync read it. */
  | "changed"
  /** The path is a symbolic link to a file that does not exist. */
  | "dangling-link"
  /** The file belongs to another user and its ownership cannot be kept. */
  | "owner";

/** A file sync refused to read or write, with the file and a machine-readable reason. */
export class SyncRefusedError extends Error {
  /** The file the refusal is about. */
  readonly path: string;
  /** Why it was refused. */
  readonly reason: SyncRefusalReason;

  constructor(
    path: string,
    reason: SyncRefusalReason,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${path}: ${detail}`, options);
    this.name = "SyncRefusedError";
    this.path = path;
    this.reason = reason;
  }
}
