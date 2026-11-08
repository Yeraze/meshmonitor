/**
 * Stable 31-bit numeric derived from the low 4 bytes of a hex pubkey.
 * The `telemetry.nodeNum` column is `NOT NULL` everywhere, but MeshCore has
 * no genuine equivalent — queries against MeshCore telemetry always go
 * through `nodeId` (the pubkey). We synthesise a non-negative integer so
 * inserts succeed without lying about Meshtastic provenance.
 *
 * Lives in `utils/` so repositories and routes can share it without
 * importing the telemetry poller. About 1 in 2^31 keys collide with a
 * Meshtastic nodeNum; callers must key identity on `nodeKey`/`publicKey`.
 */
export function nodeNumFromPubkey(publicKey: string): number {
  if (!publicKey) return 0;
  const tail = publicKey.replace(/^0x/, '').slice(-8);
  const n = parseInt(tail, 16);
  if (!Number.isFinite(n)) return 0;
  return n & 0x7fffffff;
}
