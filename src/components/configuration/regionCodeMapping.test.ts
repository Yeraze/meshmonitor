/**
 * RegionCode mapping drift guard.
 *
 * `REGION_MAP` turns a firmware-reported region NAME into its numeric code.
 * `ConfigurationTab` resolves it as `REGION_MAP[name] || 0`, so a name this
 * table lacks silently becomes UNSET(0) — and that value goes straight into the
 * `setLoRaConfig` payload, which is a whole-struct replace. A user on an
 * unmapped region who saved any unrelated LoRa setting would have written UNSET
 * back to their radio, taking it off its band.
 *
 * Every amateur 2m/70cm/1.25m region was in exactly that state: present in the
 * protobuf and in the picker, absent from this map. The picker knowing about a
 * region while the reader does not is the specific shape of drift this guards.
 *
 * Reads the protobuf directly rather than restating it, so a submodule bump
 * that adds a region fails here instead of shipping.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REGION_MAP, REGION_OPTIONS } from './constants';

/** Name -> value, straight from `enum RegionCode`. */
function protobufRegions(): Record<string, number> {
  const proto = readFileSync(resolve('protobufs/meshtastic/config.proto'), 'utf8');
  const block = /enum RegionCode\s*\{([\s\S]*?)\n\s*\}/.exec(proto);
  expect(block, 'RegionCode enum not found — did the protobuf layout change?').toBeTruthy();
  const out: Record<string, number> = {};
  // The trailing `[...]` allows for option annotations such as
  // `UA_868 = 15 [deprecated = true];`, which a naive pattern skips — and
  // skipping one would make this guard quietly under-report.
  for (const m of block![1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(\d+)\s*(?:\[[^\]]*\])?\s*;/gm)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

describe('REGION_MAP stays in step with the protobuf', () => {
  it('parses a plausible enum', () => {
    // Guards the guard: a layout change returning nothing would make the
    // coverage assertions below vacuously pass.
    const pb = protobufRegions();
    expect(Object.keys(pb).length).toBeGreaterThan(30);
    expect(pb.US).toBe(1);
    expect(pb.UNSET).toBe(0);
    // Pinned because the annotation form nearly escaped the pattern above.
    expect(pb.UA_868).toBe(15);
  });

  it('resolves every region name a device can report', () => {
    const pb = protobufRegions();
    const unresolvable = Object.keys(pb).filter((n) => !(n in REGION_MAP));

    expect(
      unresolvable,
      'These names would resolve to UNSET(0) and could be written back to the radio. ' +
      'Add them to REGION_MAP in src/components/configuration/constants.ts.',
    ).toEqual([]);
  });

  it('agrees with the protobuf on every value', () => {
    const pb = protobufRegions();
    const wrong = Object.keys(pb)
      .filter((n) => n in REGION_MAP && REGION_MAP[n] !== pb[n])
      .map((n) => `${n}: ours=${REGION_MAP[n]} protobuf=${pb[n]}`);
    expect(wrong).toEqual([]);
  });

  it('offers every region in the picker that it can read', () => {
    // The inverse drift: being able to read a region but not select it.
    const values = new Set(REGION_OPTIONS.map((o) => o.value));
    const missing = Object.entries(protobufRegions())
      .filter(([, v]) => !values.has(v))
      .map(([n, v]) => `${n} (${v})`);
    expect(missing).toEqual([]);
  });

  it('keeps the legacy ITU23_2M spelling resolvable', () => {
    // MeshMonitor's own former name for 28, which conflated ITU regions 2 and
    // 3 (separate codes upstream). Stored or exported configs may still use it.
    expect(REGION_MAP['ITU23_2M']).toBe(28);
    expect(REGION_MAP['ITU2_2M']).toBe(28);
    expect(REGION_MAP['ITU3_2M']).toBe(33);
  });
});
