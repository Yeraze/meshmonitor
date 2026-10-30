/**
 * Confine a filesystem path to an intended root directory.
 *
 * Backup records store a `filePath` / `backupPath` column. The column is
 * attacker-reachable if the database is ever written to out of band, so a path
 * read back from it must be confined to the backup root before any `fs` read or
 * delete — otherwise a poisoned row turns a download into an arbitrary file read
 * and a delete into an arbitrary file wipe (`../../` would reach the filesystem
 * root). See issues #6054 / #6055.
 */
import * as path from 'path';

/**
 * Resolve `target` against `root` and return the absolute path only when it is
 * `root` itself or a descendant of it. Throws when `target` escapes `root`
 * (via `..` traversal or an absolute path outside it).
 *
 * `target` may be relative (resolved against `root`) or absolute (kept as-is,
 * then checked). The check is a resolved-prefix test, so symlinks inside the
 * tree are treated as part of it.
 */
export function resolveWithinDir(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path "${target}" escapes the permitted directory`);
  }
  return resolved;
}

/** Non-throwing form: true when `target` stays within `root`. */
export function isWithinDir(root: string, target: string): boolean {
  try {
    resolveWithinDir(root, target);
    return true;
  } catch {
    return false;
  }
}
