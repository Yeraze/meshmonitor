/**
 * #5156: the hide predicate and the per-viewer hidden set, against the real
 * `:memory:` SQLite singleton (migration 234 columns included).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import databaseService from '../../services/database.js';
import {
  isMqttConsentWithheld,
  isAnonymousViewer,
  loadMqttConsentHiddenSet,
  makeMqttConsentHiddenSet,
  tracerouteNamesHiddenNode,
  dropMessagesNamingHiddenNodes,
  NO_HIDDEN_NODES,
  HIDE_ALL_NODES,
  ANON_HIDE_MQTT_NO_CONSENT_SETTING,
} from './mqttConsentVisibility.js';
import { loadNodeViewAccess } from './nodeEnhancer.js';

const SRC_A = 'mcv-src-a';
const SRC_B = 'mcv-src-b';
const DECLINED = 0x5156_0001;
const RF_HEARD = 0x5156_0002;
const UNKNOWN = 0x5156_0003;
const CONSENTED = 0x5156_0004;
const ANON = { username: 'anonymous' };
const SIGNED_IN = { username: 'alice' };

async function seed(sourceId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const base = { shortName: 'X', hwModel: 0, channel: 0, lastHeard: now };
  await databaseService.nodes.upsertNode({ ...base, nodeNum: DECLINED, nodeId: '!51560001', longName: 'declined', mqttOkToMqtt: false, mqttOkToMqttAt: now }, sourceId);
  await databaseService.nodes.upsertNode({ ...base, nodeNum: RF_HEARD, nodeId: '!51560002', longName: 'rf', mqttOkToMqtt: false, mqttOkToMqttAt: now, rfDirectLastHeard: now - 10 }, sourceId);
  await databaseService.nodes.upsertNode({ ...base, nodeNum: UNKNOWN, nodeId: '!51560003', longName: 'unknown' }, sourceId);
  await databaseService.nodes.upsertNode({ ...base, nodeNum: CONSENTED, nodeId: '!51560004', longName: 'yes', mqttOkToMqtt: true, mqttOkToMqttAt: now }, sourceId);
}

describe('isMqttConsentWithheld (the hide rule on one row)', () => {
  it('hides only a positive false with no direct-RF stamp', () => {
    expect(isMqttConsentWithheld({ mqttOkToMqtt: false, rfDirectLastHeard: null })).toBe(true);
    expect(isMqttConsentWithheld({ mqttOkToMqtt: 0, rfDirectLastHeard: null })).toBe(true);
    expect(isMqttConsentWithheld({ mqttOkToMqtt: false, rfDirectLastHeard: 123 })).toBe(false);
    expect(isMqttConsentWithheld({ mqttOkToMqtt: null, rfDirectLastHeard: null })).toBe(false);
    expect(isMqttConsentWithheld({})).toBe(false);
    expect(isMqttConsentWithheld({ mqttOkToMqtt: true })).toBe(false);
  });
});

describe('isAnonymousViewer', () => {
  it('matches no user and the seeded anonymous account only', () => {
    expect(isAnonymousViewer(null)).toBe(true);
    expect(isAnonymousViewer(undefined)).toBe(true);
    expect(isAnonymousViewer(ANON)).toBe(true);
    expect(isAnonymousViewer(SIGNED_IN)).toBe(false);
  });
});

describe('makeMqttConsentHiddenSet', () => {
  it('answers per source, by number or !hex id, and any source when none is given', () => {
    const set = makeMqttConsentHiddenSet(new Map([['a', new Set([DECLINED])]]));
    expect(set.active).toBe(true);
    expect(set.hides('a', DECLINED)).toBe(true);
    expect(set.hides('a', '!51560001')).toBe(true);
    expect(set.hides('b', DECLINED)).toBe(false);
    expect(set.hides(null, DECLINED)).toBe(true);
    expect(set.hides('a', null)).toBe(false);
  });

  it('is the inert set when nothing is hidden', () => {
    expect(makeMqttConsentHiddenSet(new Map([['a', new Set()]]))).toBe(NO_HIDDEN_NODES);
  });
});

describe('row helpers', () => {
  const set = makeMqttConsentHiddenSet(new Map([['a', new Set([DECLINED])]]));
  it('drops a traceroute that names the node as an end or a hop', () => {
    expect(tracerouteNamesHiddenNode(set, 'a', { fromNodeNum: 1, toNodeNum: DECLINED })).toBe(true);
    expect(tracerouteNamesHiddenNode(set, 'a', { fromNodeNum: 1, toNodeNum: 2, route: JSON.stringify([DECLINED]) })).toBe(true);
    expect(tracerouteNamesHiddenNode(set, 'a', { fromNodeNum: 1, toNodeNum: 2, routeBack: `[${DECLINED}]` })).toBe(true);
    expect(tracerouteNamesHiddenNode(set, 'a', { fromNodeNum: 1, toNodeNum: 2, route: '[3]' })).toBe(false);
    expect(tracerouteNamesHiddenNode(set, 'b', { fromNodeNum: 1, toNodeNum: DECLINED })).toBe(false);
  });

  it('drops messages from or to the node', () => {
    const rows = [
      { id: 1, fromNodeNum: DECLINED, toNodeNum: 0xffffffff },
      { id: 2, fromNodeNum: 7, toNodeNum: DECLINED },
      { id: 3, fromNodeId: '!51560001', toNodeId: '!ffffffff' },
      { id: 4, fromNodeNum: 7, toNodeNum: 0xffffffff },
    ];
    expect(dropMessagesNamingHiddenNodes(rows, set, 'a').map((r) => r.id)).toEqual([4]);
    expect(dropMessagesNamingHiddenNodes(rows, set, 'b')).toHaveLength(4);
  });
});

describe('loadMqttConsentHiddenSet (real DB)', () => {
  beforeAll(async () => {
    await databaseService.waitForReady();
    for (const id of [SRC_A, SRC_B]) {
      await databaseService.sources.deleteSource(id).catch(() => {});
      await databaseService.sources.createSource({ id, name: id, type: 'meshtastic_tcp', config: {}, enabled: true });
    }
    await seed(SRC_A);
    await seed(SRC_B);
  });

  afterEach(async () => {
    await databaseService.settings.setSourceSetting(SRC_A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '0');
    await databaseService.settings.setSourceSetting(SRC_B, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '0');
  });

  it('flag off: anonymous sees everything', async () => {
    const set = await loadMqttConsentHiddenSet(ANON, [SRC_A, SRC_B]);
    expect(set.active).toBe(false);
  });

  it('flag on: anonymous loses only the declined, never-RF node; RF-heard, unknown and consenting nodes stay', async () => {
    await databaseService.settings.setSourceSetting(SRC_A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '1');
    const set = await loadMqttConsentHiddenSet(ANON, [SRC_A, SRC_B]);
    expect(set.hides(SRC_A, DECLINED)).toBe(true);
    expect(set.hides(SRC_A, RF_HEARD)).toBe(false);
    expect(set.hides(SRC_A, UNKNOWN)).toBe(false);
    expect(set.hides(SRC_A, CONSENTED)).toBe(false);
  });

  it('per-source isolation: the flag on A does not hide the same node on B', async () => {
    await databaseService.settings.setSourceSetting(SRC_A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '1');
    const set = await loadMqttConsentHiddenSet(null, [SRC_A, SRC_B]);
    expect(set.hides(SRC_A, DECLINED)).toBe(true);
    expect(set.hides(SRC_B, DECLINED)).toBe(false);
  });

  it('a signed-in viewer is never filtered', async () => {
    await databaseService.settings.setSourceSetting(SRC_A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '1');
    expect(await loadMqttConsentHiddenSet(SIGNED_IN, [SRC_A])).toBe(NO_HIDDEN_NODES);
  });

  it('ignores the flag on a non-Meshtastic source, even when its node read fails', async () => {
    const MC = 'mqtt-consent-mc-src';
    await databaseService.sources.deleteSource(MC).catch(() => {});
    await databaseService.sources.createSource({ id: MC, name: MC, type: 'meshcore', config: {}, enabled: true });
    await databaseService.settings.setSourceSetting(MC, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '1');
    const spy = vi.spyOn(databaseService.nodes, 'getMqttConsentWithheldNodeNums').mockRejectedValue(new Error('down'));
    try {
      const set = await loadMqttConsentHiddenSet(ANON, [MC]);
      expect(set).toBe(NO_HIDDEN_NODES);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await databaseService.sources.deleteSource(MC).catch(() => {});
    }
  });

  it('loadNodeViewAccess carries the set: canViewNode refuses the node only with its number', async () => {
    await databaseService.settings.setSourceSetting(SRC_A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '1');
    // The anonymous row is seeded fire-and-forget at startup; wait for it.
    let anon = await databaseService.auth.getUserByUsername('anonymous');
    for (let i = 0; !anon && i < 80; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      anon = await databaseService.auth.getUserByUsername('anonymous');
    }
    expect(anon).toBeTruthy();
    const access = await loadNodeViewAccess(anon as never);
    expect(access.hiddenByMqttConsent.hides(SRC_A, DECLINED)).toBe(true);
    expect(access.canViewNode(SRC_A, 0, DECLINED)).toBe(false);
  });
});

describe('makeMqttConsentHiddenSet: SQL helpers', () => {
  it('reports per-source node numbers and blocked sources', () => {
    const set = makeMqttConsentHiddenSet(new Map([['a', new Set([DECLINED])], ['b', new Set([RF_HEARD])]]), new Set(['c']));
    expect(set.nodeNumsFor('a')).toEqual([DECLINED]);
    expect(set.nodeNumsFor().sort()).toEqual([DECLINED, RF_HEARD].sort());
    expect(set.blocksAll('a')).toBe(false);
    expect(set.blocksAll('c')).toBe(true);
    expect(set.hides('c', 12345)).toBe(true);
    expect(HIDE_ALL_NODES.blocksAll('anything')).toBe(true);
    expect(HIDE_ALL_NODES.hides('anything', 1)).toBe(true);
  });
});

describe('loadMqttConsentHiddenSet fails closed (#5156 review)', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await databaseService.settings.setSourceSetting(SRC_A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '0');
  });

  it('a failed settings read hides every node on every source', async () => {
    vi.spyOn(databaseService.settings, 'getSettingForSources').mockRejectedValue(new Error('settings down'));
    const set = await loadMqttConsentHiddenSet(ANON, [SRC_A, SRC_B]);
    expect(set.hides(SRC_A, UNKNOWN)).toBe(true);
    expect(set.hides(SRC_B, CONSENTED)).toBe(true);
    expect(set.blocksAll(SRC_B)).toBe(true);
  });

  it('a failed sources read hides every node', async () => {
    vi.spyOn(databaseService.sources, 'getAllSources').mockRejectedValue(new Error('sources down'));
    const set = await loadMqttConsentHiddenSet(ANON);
    expect(set.hides(SRC_A, UNKNOWN)).toBe(true);
  });

  it('a failed node read hides every node of that flagged source only', async () => {
    await databaseService.settings.setSourceSetting(SRC_A, ANON_HIDE_MQTT_NO_CONSENT_SETTING, '1');
    vi.spyOn(databaseService.nodes, 'getMqttConsentWithheldNodeNums').mockRejectedValue(new Error('nodes down'));
    const set = await loadMqttConsentHiddenSet(ANON, [SRC_A, SRC_B]);
    expect(set.hides(SRC_A, CONSENTED)).toBe(true);
    expect(set.blocksAll(SRC_A)).toBe(true);
    expect(set.hides(SRC_B, DECLINED)).toBe(false);
  });

  it('a signed-in viewer is unaffected by a failure', async () => {
    vi.spyOn(databaseService.settings, 'getSettingForSources').mockRejectedValue(new Error('settings down'));
    expect(await loadMqttConsentHiddenSet(SIGNED_IN, [SRC_A])).toBe(NO_HIDDEN_NODES);
  });
});
