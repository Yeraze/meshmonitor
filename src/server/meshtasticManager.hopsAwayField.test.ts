/**
 * Regression guard for #4604.
 *
 * `processNodeInfoMessageProtobuf` used to write `hopsAway: meshPacket.hopsAway`.
 * That looked reasonable and typechecked, but `MeshPacket` has no `hops_away`
 * field at all — it exists only on `NodeInfo` — so the expression was always
 * `undefined`. It wasn't destructive (`upsertNode` uses `?? existingNode`, so
 * undefined preserves the old value), which is exactly why it survived: it
 * failed silently and looked like working code.
 *
 * These tests pin the schema fact the removal rests on. If a future protobuf
 * bump ever adds `hops_away` to `MeshPacket`, the first test fails and whoever
 * is doing the bump gets to make a deliberate decision instead of rediscovering
 * this by hand.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProtobufDefinitions, getProtobufRoot } from './protobufLoader.js';

describe('hopsAway is not a MeshPacket field (#4604)', () => {
  beforeAll(async () => {
    await loadProtobufDefinitions();
  });

  it('MeshPacket does not declare hops_away', () => {
    const root = getProtobufRoot();
    expect(root).toBeTruthy();
    const meshPacket = root!.lookupType('meshtastic.MeshPacket');
    const fieldNames = Object.keys(meshPacket.fields);

    // Guard against both the wire name and protobufjs's camelCase alias.
    expect(fieldNames).not.toContain('hops_away');
    expect(fieldNames).not.toContain('hopsAway');
  });

  it('NodeInfo does declare hops_away — it is the only carrier', () => {
    const root = getProtobufRoot();
    const nodeInfo = root!.lookupType('meshtastic.NodeInfo');
    const fieldNames = Object.keys(nodeInfo.fields);
    // protobufjs exposes snake_case field names as declared in the .proto.
    expect(fieldNames.some((f) => f === 'hops_away' || f === 'hopsAway')).toBe(true);
  });

  it('a decoded MeshPacket yields undefined for hopsAway', () => {
    // The behavioural half: even constructing one directly, the property is
    // absent — so nothing can read a hop count off a packet by accident.
    const root = getProtobufRoot();
    const MeshPacket = root!.lookupType('meshtastic.MeshPacket');
    const decoded = MeshPacket.decode(
      MeshPacket.encode(MeshPacket.create({ from: 0x1234abcd, to: 0xffffffff })).finish(),
    ) as unknown as Record<string, unknown>;
    expect(decoded.hopsAway).toBeUndefined();
    expect(decoded.hops_away).toBeUndefined();
  });

  it('meshtasticManager no longer reads hopsAway off a MeshPacket', () => {
    // Source-level backstop. The schema tests above prove the read is
    // meaningless; this one proves it is gone, including from log statements
    // (the debug line printed the same always-undefined value).
    const src = readFileSync(resolve('src/server/meshtasticManager.ts'), 'utf8');
    expect(src).not.toMatch(/meshPacket\.hopsAway/);
  });
});
