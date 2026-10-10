/**
 * The English text of each "0 means..." hint (`NumberInput`'s `zeroHint`).
 *
 * Every field that takes 0 as a sentinel has one, and each must say what a
 * save sends. The numbers here come from the save handlers
 * (ConfigurationTab / AdminCommandsTab) and the firmware's own defaults
 * (meshtastic/firmware `src/mesh/Default.h`, `src/mqtt/MQTT.h`); a change to
 * either has to change the hint with it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const en = JSON.parse(readFileSync(join(root, 'public/locales/en.json'), 'utf8')) as Record<string, string>;

/** Every `.tsx` under src/components that is not a test. */
function componentSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return componentSources(path);
    return /\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name) ? [path] : [];
  });
}

describe('zero hints', () => {
  it.each([
    // key, the default it names, what Save sends
    // A stored 0 goes back as 0 (utils/broadcastIntervalFloor.ts). For the
    // position interval the node then keeps its default. For node-info it
    // cannot: AdminModule::handleSetConfig raises anything under 3600 to 3600,
    // 0 included, so the hint must not promise the 3 hour default.
    ['zero_hint.position_broadcast', /15 minutes or 1 hour/, /Save sends 0, so the node keeps its firmware default/],
    ['zero_hint.node_info_broadcast', /\(3 hours\)/, /Save sends 0, but the firmware stores its minimum of 3600 seconds/],
    // Not a default: firmware sends with exactly config.lora.hop_limit, so a
    // stored 0 is zero hops (Default::getConfiguredOrDefaultHopLimit).
    ['zero_hint.hop_limit', /^0 = zero hops.*factory value is 3/, /Save sends 1, not 0/],
    ['zero_hint.neighbor_info_interval', /\(6 hours\)/, /Save sends 0/],
    ['zero_hint.map_position_precision', /14 bits/, /Save sends 0/],
  ] as const)('%s names the default and what a save sends', (key, theDefault, sent) => {
    expect(en[key]).toBeDefined();
    expect(en[key]).toMatch(/^0 = /);
    expect(en[key]).toMatch(theDefault);
    expect(en[key]).toMatch(sent);
  });

  it('every field that takes 0 as a sentinel has a hint, with a key that exists', () => {
    const sites: string[] = [];
    for (const file of componentSources(join(root, 'src/components'))) {
      const source = readFileSync(file, 'utf8');
      // Up to the self-closing `/>`: the props hold `=>`, so `>` alone will not do.
      for (const match of source.matchAll(/<NumberInput\b[\s\S]*?\/>/g)) {
        if (!match[0].includes('alsoValid={[0]}')) continue;
        const hint = /zeroHint=\{t\('([^']+)'\)\}/.exec(match[0]);
        expect(hint, `${file}: a field with alsoValid={[0]} needs a zeroHint`).not.toBeNull();
        expect(en[hint![1]], `${hint![1]} is in en.json`).toBeDefined();
        sites.push(hint![1]);
      }
    }
    // Five fields, four of them on both the local and the remote form.
    expect(sites.sort()).toEqual([
      'zero_hint.hop_limit',
      'zero_hint.hop_limit',
      'zero_hint.map_position_precision',
      'zero_hint.map_position_precision',
      'zero_hint.neighbor_info_interval',
      'zero_hint.node_info_broadcast',
      'zero_hint.node_info_broadcast',
      'zero_hint.position_broadcast',
      'zero_hint.position_broadcast',
    ]);
  });
});
