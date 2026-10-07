/**
 * Notice that something a permission check depends on has changed.
 *
 * The WebSocket layer keeps each user's grants in memory so it does not query
 * per event (`socketAccess.ts`). The repositories that write users, grants,
 * API tokens, channel-database entries and sources call `notifyAccessChange`
 * here, and the socket layer drops what it holds. Hooked at the repository
 * rather than the route so every writer is covered: the user routes, OIDC and
 * proxy provisioning, first-boot seeding.
 *
 * A leaf module: no imports, so a repository can use it without pulling in
 * the server.
 */
export type AccessChange =
  /** A user's grants, admin flag or active flag changed, or the user was deleted. */
  | { kind: 'user'; userId: number }
  /** An API token was revoked or deleted. */
  | { kind: 'tokens' }
  /** A session ended (logout). */
  | { kind: 'session'; sessionId: string }
  /** Something every user's access may depend on: a source or a channel-database entry. */
  | { kind: 'all' };

type Listener = (change: AccessChange) => void;

const listeners = new Set<Listener>();

/** Subscribe. Returns the function that unsubscribes. */
export function onAccessChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell every subscriber. A listener that throws does not stop the write. */
export function notifyAccessChange(change: AccessChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch {
      // The write has already happened; a failed notice only delays the
      // socket layer until its TTL.
    }
  }
}
