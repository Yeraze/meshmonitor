import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  MESH_PROTOCOLS,
  MESH_PROTOCOL_COLOR_VAR,
  MESH_PROTOCOL_LABEL,
  meshProtocolColorVar,
  sourceTypeMeshProtocol,
} from './meshProtocol';

describe('sourceTypeMeshProtocol (#5744)', () => {
  it.each([
    ['meshtastic_tcp', 'meshtastic'],
    ['mqtt_broker', 'meshtastic'],
    ['mqtt_bridge', 'meshtastic'],
    ['meshcore', 'meshcore'],
    ['meshcore_mqtt', 'meshcore'],
    ['reticulum', 'reticulum'],
  ])('maps %s to %s', (type, protocol) => {
    expect(sourceTypeMeshProtocol(type)).toBe(protocol);
  });

  it('reads a missing or unknown type as Meshtastic', () => {
    expect(sourceTypeMeshProtocol(null)).toBe('meshtastic');
    expect(sourceTypeMeshProtocol(undefined)).toBe('meshtastic');
    expect(sourceTypeMeshProtocol('')).toBe('meshtastic');
    expect(sourceTypeMeshProtocol('something_new')).toBe('meshtastic');
  });

  it('matches exact strings only', () => {
    expect(sourceTypeMeshProtocol('meshcore_future_device')).toBe('meshtastic');
    expect(sourceTypeMeshProtocol('MeshCore')).toBe('meshtastic');
  });
});

describe('protocol colours (#5744)', () => {
  it('uses the node popup badge tokens, plus the accent for Reticulum', () => {
    expect(meshProtocolColorVar('meshtastic')).toBe('var(--color-success)');
    expect(meshProtocolColorVar('meshcore')).toBe('var(--color-caution)');
    expect(meshProtocolColorVar('reticulum')).toBe('var(--color-accent)');
  });

  it('gives every protocol a role token with no fallback value', () => {
    for (const p of MESH_PROTOCOLS) {
      expect(MESH_PROTOCOL_COLOR_VAR[p]).toMatch(/^var\(--color-[a-z-]+\)$/);
      expect(MESH_PROTOCOL_LABEL[p]).toBeTruthy();
    }
  });

  it('agrees with the node popup protocol badge', () => {
    const css = readFileSync(resolve('src/styles/nodes.css'), 'utf8');
    for (const p of ['meshtastic', 'meshcore'] as const) {
      const rule = new RegExp(
        `\\.node-popup-protocol-badge\\.protocol-${p}\\s*\\{\\s*background:\\s*([^;]+);`,
      ).exec(css);
      expect(rule?.[1].trim()).toBe(MESH_PROTOCOL_COLOR_VAR[p]);
    }
  });

  it('agrees with ProtocolStripe.module.css', () => {
    const css = readFileSync(
      resolve('src/components/messages/ProtocolStripe.module.css'),
      'utf8',
    );
    for (const p of MESH_PROTOCOLS) {
      const rule = new RegExp(
        `\\[data-protocol='${p}'\\]\\s*\\{\\s*--protocol-color:\\s*([^;]+);`,
      ).exec(css);
      expect(rule?.[1].trim()).toBe(MESH_PROTOCOL_COLOR_VAR[p]);
    }
    // One rule per protocol, no strays.
    expect(css.match(/--protocol-color:/g)).toHaveLength(MESH_PROTOCOLS.length);
  });
});
