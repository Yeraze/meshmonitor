import { describe, it, expect } from 'vitest';
import { latestMeshCoreRelease, parseMeshCoreRelease, type MeshCoreRelease } from './meshcoreFirmwareReleases.js';
import { compareFirmwareVersions } from '../../utils/firmwareVersion.js';

const rel = (tag: string, prerelease = false) => parseMeshCoreRelease({ tag_name: tag, prerelease, html_url: `https://x/${tag}` })!;

describe('MeshCore releases (#4943)', () => {
  it('parses the role-prefixed tags MeshCore uses and ignores others', () => {
    expect(rel('companion-v1.18.0')).toMatchObject({ role: 'companion', version: '1.18.0' });
    expect(rel('room-server-v1.17.1')).toMatchObject({ role: 'room-server', version: '1.17.1' });
    expect(parseMeshCoreRelease({ tag_name: 'v1.18.0' })).toBeNull();
    expect(parseMeshCoreRelease({ tag_name: 'sensor-v1.0.0' })).toBeNull();
    expect(parseMeshCoreRelease({})).toBeNull();
  });

  it('picks the newest release for the role, stable unless the channel allows prereleases', () => {
    const all: MeshCoreRelease[] = [
      rel('companion-v1.17.1'),
      rel('companion-v1.18.0'),
      rel('companion-v1.19.0', true),
      rel('repeater-v1.18.1'),
    ];
    expect(latestMeshCoreRelease(all, 'companion', 'stable')?.version).toBe('1.18.0');
    expect(latestMeshCoreRelease(all, 'companion', 'alpha')?.version).toBe('1.19.0');
    expect(latestMeshCoreRelease(all, 'repeater', 'custom')?.version).toBe('1.18.1');
    // An inherited Meshtastic nightly means stable for MeshCore.
    expect(latestMeshCoreRelease(all, 'companion', 'nightly')?.version).toBe('1.18.0');
    expect(latestMeshCoreRelease(all, 'room-server', 'stable')).toBeNull();
  });

  it('compares a live MeshCore version string against a release version', () => {
    expect(compareFirmwareVersions('v1.15.0-dee3e26', '1.18.0')).toBeLessThan(0);
    expect(compareFirmwareVersions('1.18.0', '1.18.0')).toBe(0);
    expect(compareFirmwareVersions('2.7.18.abcdef', '2.7.15')).toBeGreaterThan(0);
    expect(compareFirmwareVersions('garbage', '1.0.0')).toBeNull();
  });
});
