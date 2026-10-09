import { describe, it, expect } from 'vitest';
import { canOpenSourceSettings } from './sourceSettingsAccess';

/** A viewer holding exactly these grants; `settings` is per-source (#4416). */
const viewer = (...grants: string[]) =>
  (resource: string, action: 'read' | 'write', options?: { anySource?: boolean }) => {
    if (resource === 'settings' && !options?.anySource) return false;
    return grants.includes(`${resource}:${action}`);
  };

describe('canOpenSourceSettings (#5683 follow-up)', () => {
  it('opens for settings:read on any source, on every source type', () => {
    for (const type of ['meshtastic_tcp', 'mqtt_bridge', 'mqtt_broker', null]) {
      expect(canOpenSourceSettings(viewer('settings:read'), type), String(type)).toBe(true);
    }
  });

  it('asks for the any-source union, as the server does for the unscoped settings routes', () => {
    const seen: unknown[] = [];
    canOpenSourceSettings((resource, action, options) => {
      seen.push([resource, action, options]);
      return true;
    }, 'meshtastic_tcp');
    expect(seen).toEqual([['settings', 'read', { anySource: true }]]);
  });

  it('opens an MQTT bridge for sources:read alone: the bridge setup lives there now', () => {
    // This viewer reached the bridge setup through its own tab before. They
    // must not lose it because that tab's nav entry went away.
    expect(canOpenSourceSettings(viewer('sources:read'), 'mqtt_bridge')).toBe(true);
    expect(canOpenSourceSettings(viewer('sources:read', 'sources:write'), 'mqtt_bridge')).toBe(true);
  });

  it('does not open any other source type for sources:read alone', () => {
    for (const type of ['meshtastic_tcp', 'mqtt_broker', 'meshcore', null, undefined]) {
      expect(canOpenSourceSettings(viewer('sources:read'), type), String(type)).toBe(false);
    }
  });

  it('stays shut with neither grant', () => {
    expect(canOpenSourceSettings(viewer(), 'mqtt_bridge')).toBe(false);
    expect(canOpenSourceSettings(viewer('configuration:read', 'sources:write'), 'mqtt_bridge')).toBe(false);
  });
});
