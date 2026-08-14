/**
 * "Is this one of MeshMonitor's own nodes?" — cross-source self-identity.
 *
 * The per-source self-origin guard (#3914) asks a single source's manager for
 * its local node (`getLocalNodeInfo()`). That works for a Meshtastic TCP or
 * MeshCore source, which owns a physical node, but an `mqtt_bridge` source has
 * NO local identity at all — `MqttBridgeManager.getLocalNodeInfo()` returns
 * null — so the guard silently degrades to a no-op there.
 *
 * That matters because our own traffic reaches a bridge anyway: a message we
 * send through a Meshtastic source travels the mesh, some third-party gateway
 * uplinks it to the broker, and the bridge downlinks it right back to us as an
 * ordinary inbound packet from our own nodeNum. Without a cross-source check an
 * automation would fire on MeshMonitor's own reply and answer itself forever
 * (#4593).
 *
 * The set is read live from the registry — no caching — so a source that
 * connects, reconnects with a new nodeNum, or is removed is reflected
 * immediately. An empty registry (unit tests, boot) yields an empty set, i.e.
 * nothing is treated as ours: fail-open, matching the #3914 convention that an
 * unresolvable identity never drops an event.
 */

import { sourceManagerRegistry } from '../sourceManagerRegistry.js';
import { isMeshCoreManager, isReticulumManager } from '../sourceManagerTypes.js';

/**
 * Every local node number MeshMonitor currently owns, across all registered
 * sources. Sources with no local identity (MQTT bridges) contribute nothing.
 */
export function getOwnNodeNums(): number[] {
  const nums: number[] = [];
  for (const manager of sourceManagerRegistry.getAllManagers()) {
    let nodeNum: unknown;
    try {
      nodeNum = manager.getLocalNodeInfo()?.nodeNum;
    } catch {
      continue; // a manager mid-connect must never break the caller
    }
    if (nodeNum == null) continue;
    const n = Number(nodeNum);
    if (Number.isFinite(n) && !nums.includes(n)) nums.push(n);
  }
  return nums;
}

/** True when `nodeNum` is the local node of ANY registered source. */
export function isOwnNodeNum(nodeNum: number | null | undefined): boolean {
  if (nodeNum == null) return false;
  const n = Number(nodeNum);
  if (!Number.isFinite(n)) return false;
  return getOwnNodeNums().includes(n);
}

/**
 * Every local MeshCore public key MeshMonitor currently owns, across all
 * registered MeshCore sources. Meshtastic/MQTT managers contribute nothing.
 * Keys are lowercased for case-insensitive comparison, matching the #3914
 * per-source `getSelfPublicKey` convention.
 */
export function getOwnPublicKeys(): string[] {
  const keys: string[] = [];
  for (const manager of sourceManagerRegistry.getAllManagers()) {
    if (!isMeshCoreManager(manager)) continue;
    let k: unknown;
    try {
      k = manager.getLocalNode()?.publicKey;
    } catch {
      continue; // a manager mid-connect must never break the caller
    }
    if (typeof k !== 'string' || !k) continue;
    const lower = k.toLowerCase();
    if (!keys.includes(lower)) keys.push(lower);
  }
  return keys;
}

/** True when `pubkey` is the local node public key of ANY registered MeshCore source. */
export function isOwnPublicKey(pubkey: string | null | undefined): boolean {
  if (!pubkey) return false;
  return getOwnPublicKeys().includes(pubkey.toLowerCase());
}

/**
 * Every local LXMF destination hash MeshMonitor currently owns, across all
 * registered Reticulum sources (#3960 Phase 2 WP3). Mirrors
 * {@link getOwnPublicKeys}. Non-Reticulum managers contribute nothing.
 */
export function getOwnReticulumAddresses(): string[] {
  const hashes: string[] = [];
  for (const manager of sourceManagerRegistry.getAllManagers()) {
    if (!isReticulumManager(manager)) continue;
    let addrs: unknown;
    try {
      addrs = manager.getOwnAddresses();
    } catch {
      continue; // a manager mid-connect must never break the caller
    }
    if (!Array.isArray(addrs)) continue;
    for (const a of addrs) {
      if (typeof a !== 'string' || !a) continue;
      const lower = a.toLowerCase();
      if (!hashes.includes(lower)) hashes.push(lower);
    }
  }
  return hashes;
}

/** True when `hash` is the local LXMF destination of ANY registered Reticulum source. */
export function isOwnReticulumAddress(hash: string | null | undefined): boolean {
  if (!hash) return false;
  return getOwnReticulumAddresses().includes(hash.toLowerCase());
}
