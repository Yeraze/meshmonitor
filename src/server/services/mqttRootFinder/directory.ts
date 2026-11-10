/**
 * Bundled copy of the Meshtastic MQTT root directory (#6287, design#167 R9).
 *
 * `src/server/data/mqttRoots.json` is a verbatim copy of `data/mqttRoots.json` from
 * https://github.com/meshtastic/api, so the finder works offline. Phase 1 has
 * no live refresh.
 */

import rawDirectory from '../../data/mqttRoots.json' with { type: 'json' };

/** meshtastic/api commit that last touched data/mqttRoots.json. */
export const MQTT_ROOTS_UPSTREAM_COMMIT = '7406a79f7ecd819d7df6c1761f4e0ac6fde657d3';
/** Git blob SHA of the bundled file at that commit. */
export const MQTT_ROOTS_UPSTREAM_BLOB = '75379aac77e93cb05d319a662a1f5600d8057e91';
/** Committer date of the upstream commit. */
export const MQTT_ROOTS_UPSTREAM_DATE = '2026-10-18T11:44:05Z';

export interface DirectoryEntry {
  root: string;
  name: string;
  /** [lat, lon] in degrees. */
  center: [number, number];
  radiusKm: number;
}

export interface MqttRootDirectory {
  entries: DirectoryEntry[];
  /** `US-TX` -> list of bordering `US-XX` codes. */
  neighbors: Record<string, string[]>;
  /** Country code -> lowercase subdivision name -> root segment. */
  subdivisionSegments: Record<string, Record<string, string>>;
}

/** The bundled directory. */
export function getDirectory(): MqttRootDirectory {
  const d = rawDirectory as unknown as Partial<MqttRootDirectory>;
  return {
    entries: d.entries ?? [],
    neighbors: d.neighbors ?? {},
    subdivisionSegments: d.subdivisionSegments ?? {},
  };
}
