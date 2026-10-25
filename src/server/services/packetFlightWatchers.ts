/**
 * Who is watching live packet traffic (#4835), per source.
 *
 * A socket adds itself with `packet-flights:subscribe` when a map turns the
 * "Live packet traffic" layer on, and removes itself when the layer goes off
 * or the socket disconnects. The ingest paths ask `hasPacketFlightWatchers()`
 * before they build anything, so a source nobody watches costs one Map lookup
 * per packet and sends nothing.
 *
 * In memory only: a restart drops every entry, and clients subscribe again
 * when their socket reconnects.
 */

const watchersBySource = new Map<string, Set<string>>();

/** Add `socketId` as a watcher of `sourceId`. */
export function watchPacketFlights(socketId: string, sourceId: string): void {
  let set = watchersBySource.get(sourceId);
  if (!set) {
    set = new Set();
    watchersBySource.set(sourceId, set);
  }
  set.add(socketId);
}

/** Remove `socketId` from the listed sources, or from every source when none are listed. */
export function unwatchPacketFlights(socketId: string, sourceIds?: Iterable<string>): void {
  const targets = sourceIds ? Array.from(sourceIds) : Array.from(watchersBySource.keys());
  for (const sourceId of targets) {
    const set = watchersBySource.get(sourceId);
    if (!set) continue;
    set.delete(socketId);
    if (set.size === 0) watchersBySource.delete(sourceId);
  }
}

/** True while at least one socket watches `sourceId`. */
export function hasPacketFlightWatchers(sourceId: string | null | undefined): boolean {
  return !!sourceId && watchersBySource.has(sourceId);
}

/** True when `socketId` watches `sourceId`. */
export function isWatchingPacketFlights(socketId: string, sourceId: string | null | undefined): boolean {
  return !!sourceId && watchersBySource.get(sourceId)?.has(socketId) === true;
}

/** The number of sockets watching `sourceId`. */
export function packetFlightWatcherCount(sourceId: string): number {
  return watchersBySource.get(sourceId)?.size ?? 0;
}

/** Tests only: forget every watcher. */
export function resetPacketFlightWatchers(): void {
  watchersBySource.clear();
}
