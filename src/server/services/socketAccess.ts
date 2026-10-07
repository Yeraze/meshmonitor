/**
 * What one user may receive over the WebSocket, loaded once and reused.
 *
 * Events are frequent (every packet on a busy MQTT source) and there may be
 * many sockets, so the gate in `socketEventGates.ts` must not query per event
 * per socket. A user's grants are loaded here in a few queries, kept per USER
 * (every socket of that user shares them), and answered in memory.
 *
 * Staleness: `invalidateSocketAccess` drops what is held as soon as a
 * repository reports a change (`src/db/accessChanges.ts`), so a revoked grant
 * stops events on the next one. `SOCKET_ACCESS_TTL_MS` is the backstop for a
 * write that reaches the database some other way: nothing older is ever used.
 */
import databaseService from '../../services/database.js';
import { loadNodeViewAccess, type NodeViewAccess } from '../utils/nodeEnhancer.js';
import {
  getUserReadableVirtualChannelIds,
  hasAnyReadableVirtualChannel,
  type ReadableVirtualIds,
} from '../utils/virtualChannelPermissions.js';
import { mayViewSourceEndpointWith } from '../utils/sourceConfigRedaction.js';
import { resolveMeshcoreKeyAccess } from '../utils/meshcoreKeyAccess.js';
import type { MeshCoreKeyAccessFilter } from '../../db/repositories/index.js';
import type { ResourceType, PermissionAction } from '../../types/permission.js';
import { holdsAnyGrantOn } from '../utils/sourcePermissions.js';

/** The longest a socket acts on grants it has not re-read. */
export const SOCKET_ACCESS_TTL_MS = 30_000;

export interface SocketViewer {
  readonly userId: number;
  readonly isAdmin: boolean;
  /** `resource:action` on `sourceId`. A global resource ignores the source. */
  can(resource: ResourceType, action: PermissionAction, sourceId: string): boolean;
  /** True when the user holds any grant at all on `sourceId`. */
  holdsAnyGrantOn(sourceId: string): boolean;
  /** The node rule of `GET /api/poll`: `channel_N:viewOnMap` on the source. */
  canViewNode(sourceId: string, channel: number | null | undefined): boolean;
  /** `nodes_private:read` on the source. */
  canViewPrivate(sourceId: string): boolean;
  /** Channel-database entries the user may read (global by design). */
  readonly readableVirtual: ReadableVirtualIds;
  /** True when the user holds `read` or `viewOnMap` on any channel-database entry. */
  readonly hasVirtualGrant: boolean;
  /** `mayViewSourceEndpoint`: signed in with `sources:read`. */
  readonly mayViewEndpoint: boolean;
  /**
   * Fingerprints of the MeshCore channel keys the user may read (#5551).
   * Loaded on first use: it costs a lookup per source, and most events never
   * need it.
   */
  keyAccess(): Promise<MeshCoreKeyAccessFilter>;
  /** `keyAccess()` once it has resolved, else undefined. */
  readonly loadedKeyAccess: MeshCoreKeyAccessFilter | undefined;
}

const ADMIN_NODE_ACCESS: Pick<NodeViewAccess, 'canViewNode' | 'canViewPrivate'> = {
  canViewNode: () => true,
  canViewPrivate: () => true,
};

function adminViewer(userId: number): SocketViewer {
  return {
    userId,
    isAdmin: true,
    can: () => true,
    holdsAnyGrantOn: () => true,
    canViewNode: ADMIN_NODE_ACCESS.canViewNode,
    canViewPrivate: ADMIN_NODE_ACCESS.canViewPrivate,
    readableVirtual: 'all',
    hasVirtualGrant: true,
    mayViewEndpoint: true,
    keyAccess: () => Promise.resolve('all'),
    loadedKeyAccess: 'all',
  };
}

/**
 * Read `userId`'s grants. Null when the user no longer exists or is not
 * active: such a socket is disconnected.
 */
async function buildViewer(userId: number): Promise<SocketViewer | null> {
  const user = await databaseService.findUserByIdAsync(userId);
  if (!user || !user.isActive) return null;
  // The admin fast path: one row read, no grant queries, no per-event checks.
  if (user.isAdmin) return adminViewer(userId);

  const [nodes, readableVirtual] = await Promise.all([
    loadNodeViewAccess(user),
    getUserReadableVirtualChannelIds(user, false),
  ]);
  const permissions = nodes.permissions;
  let keyAccessPromise: Promise<MeshCoreKeyAccessFilter> | undefined;
  let loadedKeyAccess: MeshCoreKeyAccessFilter | undefined;
  return {
    userId,
    isAdmin: false,
    can: (resource, action, sourceId) => permissions.can(resource, action, sourceId),
    holdsAnyGrantOn: (sourceId) => holdsAnyGrantOn(permissions, sourceId),
    canViewNode: (sourceId, channel) => nodes.canViewNode(sourceId, channel),
    canViewPrivate: (sourceId) => nodes.canViewPrivate(sourceId),
    readableVirtual,
    // `nodes.sources` is 'all' for a non-admin only when a virtual channel
    // grants viewOnMap.
    hasVirtualGrant: hasAnyReadableVirtualChannel(readableVirtual) || nodes.sources === 'all',
    mayViewEndpoint: mayViewSourceEndpointWith(user, permissions),
    keyAccess() {
      keyAccessPromise ??= resolveMeshcoreKeyAccess({ id: userId, isAdmin: false }).then((access) => {
        loadedKeyAccess = access;
        return access;
      });
      return keyAccessPromise;
    },
    get loadedKeyAccess() {
      return loadedKeyAccess;
    },
  };
}

interface Entry {
  /** Bumped by every invalidation, so a load that started before it is not kept. */
  generation: number;
  loadedAt: number;
  /** undefined: nothing usable held. null: the user is gone or inactive. */
  viewer: SocketViewer | null | undefined;
  loading?: Promise<SocketViewer | null>;
}

const cache = new Map<number, Entry>();

/**
 * The viewer held for `userId` if it is fresh, with no I/O. `undefined` means
 * it must be loaded (`loadSocketViewer`). `null` means the user is gone.
 */
export function peekSocketViewer(userId: number, now: number = Date.now()): SocketViewer | null | undefined {
  const entry = cache.get(userId);
  if (!entry || entry.viewer === undefined) return undefined;
  if (now - entry.loadedAt >= SOCKET_ACCESS_TTL_MS) return undefined;
  return entry.viewer;
}

/** Load (or join the load in flight for) `userId`'s viewer. */
export function loadSocketViewer(userId: number): Promise<SocketViewer | null> {
  let entry = cache.get(userId);
  if (!entry) {
    entry = { generation: 0, loadedAt: 0, viewer: undefined };
    cache.set(userId, entry);
  }
  if (entry.loading) return entry.loading;
  const held = entry;
  const loading = (async () => {
    for (;;) {
      const generation = held.generation;
      const viewer = await buildViewer(userId);
      // Invalidated while reading: what was read may predate the change.
      if (held.generation !== generation) continue;
      held.viewer = viewer;
      held.loadedAt = Date.now();
      return viewer;
    }
  })().finally(() => {
    if (held.loading === loading) held.loading = undefined;
  });
  held.loading = loading;
  return loading;
}

/** Drop what is held for one user, or for every user. */
export function invalidateSocketAccess(userId?: number): void {
  const entries = userId === undefined ? cache.values() : [cache.get(userId)];
  for (const entry of entries) {
    if (!entry) continue;
    entry.generation++;
    entry.viewer = undefined;
  }
}

/** Forget a user with no socket left. */
export function forgetSocketViewer(userId: number): void {
  const entry = cache.get(userId);
  if (entry && !entry.loading) cache.delete(userId);
}

/** Test seam: empty the cache. */
export function resetSocketAccess(): void {
  cache.clear();
}
