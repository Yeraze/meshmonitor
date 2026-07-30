/**
 * MeshCore API Routes — synthetic local-contact row (#4438)
 *
 * Several MeshCore endpoints fold the operator's own node into the
 * contacts array they return, so the UI can show/position/exempt-from-
 * age-filtering "yourself" the same way it treats every other contact.
 * Before this module, each producer hand-rolled that row and every
 * *reader* detected it with `advName?.includes('(local)')` — a string
 * match against user-visible display text, so a stranger who happened to
 * name their own device `Foo (local)` was silently treated as the local
 * node too (issue #4438).
 *
 * This module is now the SOLE construction site for that row. Every
 * producer (`GET /contacts`, `GET /snapshot`, `POST /contacts/refresh`)
 * calls `buildLocalContactRow()` for the local row and `withoutLocalFlag()`
 * for the rest, so "every producer sets `isLocal` correctly" reduces to
 * "there is exactly one construction site" — a fact a grep-based test
 * (`meshcoreLocalContactRow.test.ts`, T-C1) can pin, so a future fourth
 * route that hand-rolls a local row fails the build.
 *
 * The `(local)` SUFFIX ON `advName` IS KEPT — it is user-visible display
 * text asserted by `MeshCoreNodesView.test.tsx`. Only the substring MATCH
 * on readers is removed; `isLocal` is the new, robust predicate. Do not
 * conflate "remove the string match" with "remove the string".
 */

import type { MeshCoreContact, MeshCoreNode } from '../meshcoreManager.js';

/** The manager's local-node shape, as returned by `manager.getLocalNode()`. */
export type MeshCoreLocalNode = MeshCoreNode;

/**
 * The wire shape every contact-returning MeshCore route must send:
 * the manager's `MeshCoreContact` plus a REQUIRED `isLocal` flag. Required
 * (not optional) so a route that builds its response array typed as
 * `MeshCoreContactResponse[]` gets a compile error if it forgets to stamp
 * `isLocal` on any row — the only place a compile-time guarantee buys
 * anything for this flag (the client type stays optional; see
 * `src/utils/meshcoreHelpers.ts`).
 */
export type MeshCoreContactResponse = MeshCoreContact & { isLocal: boolean };

/**
 * Build the synthetic contact row representing the operator's own node.
 * Callers are responsible for the existing "only include when positioned"
 * guard (`localNode && localNode.latitude && localNode.longitude`) — this
 * function just constructs the row.
 */
export function buildLocalContactRow(
  localNode: MeshCoreLocalNode,
): MeshCoreContactResponse & { isLocal: true } {
  return {
    publicKey: localNode.publicKey,
    advName: `${localNode.name} (local)`,
    name: localNode.name,
    latitude: localNode.latitude,
    longitude: localNode.longitude,
    advType: localNode.advType,
    rssi: undefined,
    snr: undefined,
    lastSeen: Date.now(),
    isLocal: true,
  };
}

/**
 * Stamp `isLocal: false` on an array of ordinary (non-local) contacts for
 * the wire response. Centralized so every route uses the same typed
 * mapping instead of re-deriving the object shape.
 */
export function withoutLocalFlag(contacts: MeshCoreContact[]): MeshCoreContactResponse[] {
  return contacts.map((c) => ({ ...c, isLocal: false }));
}
