/**
 * Pure builder tests for the ATAK/CoT Phase 3 feed server (issue #3691).
 * No I/O, no mocked DB — these exercise `escapeXml`/`buildNodeEvent`/
 * `buildContactEvent`/`nodeUid` in isolation. See
 * docs/internal/dev-notes/ATAK_COT_PHASE3_SPEC.md §5a.
 */
import { describe, it, expect } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import {
  escapeXml,
  buildNodeEvent,
  buildContactEvent,
  nodeUid,
} from './cotFeedService.js';
import type { AtakContactRow } from '../../db/repositories/atakContacts.js';
import type { DbNode } from '../../db/types.js';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const ONE_MIN = 60_000;

type NodeRow = DbNode & { sourceId: string };

function makeNode(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    nodeNum: 0xaabbccdd,
    nodeId: '!aabbccdd',
    sourceId: 'source-a',
    longName: 'Alpha Node',
    shortName: 'ALFA',
    hwModel: 43,
    latitude: 38.8895,
    longitude: -77.0353,
    altitude: 12,
    batteryLevel: 77,
    lastHeard: Math.floor(NOW / 1000) - 60, // 1 minute ago
    positionOverrideEnabled: false,
    positionOverrideIsPrivate: false,
    latitudeOverride: null,
    longitudeOverride: null,
    altitudeOverride: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as NodeRow;
}

function makeContact(overrides: Partial<AtakContactRow> = {}): AtakContactRow {
  return {
    uid: 'EUD-ALPHA-1',
    sourceId: 'source-a',
    nodeNum: 0xaabbccdd,
    callsign: 'ALPHA-1',
    deviceCallsign: 'EUD-ALPHA-1',
    team: 9, // Blue
    role: 1, // Team Member
    battery: 85,
    latitude: 38.8895,
    longitude: -77.0353,
    altitude: 12,
    speed: 3,
    course: 270,
    lastSeen: NOW - ONE_MIN,
    createdAt: NOW - 10 * ONE_MIN,
    ...overrides,
  };
}

/** Parses a produced event document and returns its single root `<event>` element. */
function parseEvent(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  expect(root).toBeTruthy();
  expect(root.tagName).toBe('event');
  return root;
}

describe('escapeXml', () => {
  it('escapes all five XML-significant characters', () => {
    expect(escapeXml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('escapes & before other entities are introduced (no double-escape bug)', () => {
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;');
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('leaves plain strings unchanged', () => {
    expect(escapeXml('ALPHA-1')).toBe('ALPHA-1');
    expect(escapeXml('')).toBe('');
  });
});

describe('nodeUid', () => {
  it('produces MESHMON-<sourceId>-<nodeId>', () => {
    expect(nodeUid({ sourceId: 'source-a', nodeId: '!aabbccdd' })).toBe('MESHMON-source-a-!aabbccdd');
  });

  it('is stable for the same (sourceId, nodeId)', () => {
    const a = nodeUid({ sourceId: 'src1', nodeId: '!11223344' });
    const b = nodeUid({ sourceId: 'src1', nodeId: '!11223344' });
    expect(a).toBe(b);
  });

  it('MeshCore pubkey-derived nodeId produces a stable uid (E9)', () => {
    const meshcoreId = '!a1b2c3d4'; // meshcoreManager: '!' + senderPubKey.substring(0,8)
    const uid = nodeUid({ sourceId: 'meshcore-1', nodeId: meshcoreId });
    expect(uid).toBe('MESHMON-meshcore-1-!a1b2c3d4');
    // Two distinct MeshCore nodes get distinct uids.
    const other = nodeUid({ sourceId: 'meshcore-1', nodeId: '!deadbeef' });
    expect(other).not.toBe(uid);
  });
});

describe('buildNodeEvent', () => {
  it('produces a well-formed <event> with correct uid/type/position/time fields', () => {
    const node = makeNode();
    const xml = buildNodeEvent(node, 'My Meshtastic Source', NOW);
    expect(xml).not.toBeNull();
    const root = parseEvent(xml!);

    expect(root.getAttribute('uid')).toBe('MESHMON-source-a-!aabbccdd');
    expect(root.getAttribute('type')).toBe('a-f-G-U-C');
    expect(root.getAttribute('how')).toBe('m-g');
    expect(root.getAttribute('time')).toBe(new Date(NOW).toISOString());
    expect(root.getAttribute('start')).toBe(new Date(NOW).toISOString());

    const expectedStale = new Date((node.lastHeard! * 1000) + 60 * ONE_MIN).toISOString();
    expect(root.getAttribute('stale')).toBe(expectedStale);

    const point = root.getElementsByTagName('point')[0];
    expect(point.getAttribute('lat')).toBe('38.8895');
    expect(point.getAttribute('lon')).toBe('-77.0353');
    expect(point.getAttribute('hae')).toBe('12');
    expect(point.getAttribute('ce')).toBe('9999999');
    expect(point.getAttribute('le')).toBe('9999999');

    const contact = root.getElementsByTagName('contact')[0];
    expect(contact.getAttribute('callsign')).toBe('ALFA');
  });

  it('falls back callsign shortName -> longName -> nodeId', () => {
    const withShort = buildNodeEvent(makeNode({ shortName: 'ALFA', longName: 'Alpha Node' }), undefined, NOW)!;
    expect(parseEvent(withShort).getElementsByTagName('contact')[0].getAttribute('callsign')).toBe('ALFA');

    const withLongOnly = buildNodeEvent(makeNode({ shortName: null, longName: 'Alpha Node' }), undefined, NOW)!;
    expect(parseEvent(withLongOnly).getElementsByTagName('contact')[0].getAttribute('callsign')).toBe('Alpha Node');

    const withNodeIdOnly = buildNodeEvent(makeNode({ shortName: null, longName: null }), undefined, NOW)!;
    expect(parseEvent(withNodeIdOnly).getElementsByTagName('contact')[0].getAttribute('callsign')).toBe('!aabbccdd');
  });

  it('returns null when there is no usable position (E4)', () => {
    expect(buildNodeEvent(makeNode({ latitude: null, longitude: null }), undefined, NOW)).toBeNull();
    expect(buildNodeEvent(makeNode({ latitude: NaN, longitude: -77 }), undefined, NOW)).toBeNull();
  });

  it('returns null for a private position override (E6)', () => {
    const node = makeNode({
      positionOverrideEnabled: true,
      positionOverrideIsPrivate: true,
      latitudeOverride: 1,
      longitudeOverride: 2,
    });
    expect(buildNodeEvent(node, undefined, NOW)).toBeNull();
  });

  it('still renders a non-private position override', () => {
    const node = makeNode({
      latitude: 10,
      longitude: 10,
      positionOverrideEnabled: true,
      positionOverrideIsPrivate: false,
      latitudeOverride: 40,
      longitudeOverride: -70,
      altitudeOverride: 99,
    });
    const xml = buildNodeEvent(node, undefined, NOW)!;
    const point = parseEvent(xml).getElementsByTagName('point')[0];
    expect(point.getAttribute('lat')).toBe('40');
    expect(point.getAttribute('lon')).toBe('-70');
  });

  it('returns null when already-stale (lastHeard older than 60 min)', () => {
    const staleNode = makeNode({ lastHeard: Math.floor((NOW - 61 * ONE_MIN) / 1000) });
    expect(buildNodeEvent(staleNode, undefined, NOW)).toBeNull();
  });

  it('returns null when lastHeard is missing (no cadence to stale against)', () => {
    expect(buildNodeEvent(makeNode({ lastHeard: null }), undefined, NOW)).toBeNull();
  });

  it('escapes an XML injection payload in the callsign (E5)', () => {
    const node = makeNode({ shortName: 'a"/><evil>', longName: null });
    const xml = buildNodeEvent(node, undefined, NOW)!;
    const root = parseEvent(xml);
    // A single <event> root with no injected sibling elements.
    expect(root.tagName).toBe('event');
    const contactEls = root.getElementsByTagName('contact');
    expect(contactEls.length).toBe(1);
    expect(contactEls[0].getAttribute('callsign')).toBe('a"/><evil>');
    // No stray <evil> element was created by the injection attempt.
    expect(root.getElementsByTagName('evil').length).toBe(0);
  });
});

describe('buildContactEvent', () => {
  it('produces a well-formed <event> with __group/status/track and un-prefixed uid', () => {
    const row = makeContact();
    const xml = buildContactEvent(row, NOW);
    expect(xml).not.toBeNull();
    const root = parseEvent(xml!);

    // uid == row.uid, no MESHMON- prefix.
    expect(root.getAttribute('uid')).toBe('EUD-ALPHA-1');
    expect(root.getAttribute('type')).toBe('a-f-G-U-C');

    const expectedStale = new Date(row.lastSeen + 15 * ONE_MIN).toISOString();
    expect(root.getAttribute('stale')).toBe(expectedStale);

    const group = root.getElementsByTagName('__group')[0];
    expect(group).toBeTruthy();
    expect(group.getAttribute('name')).toBe('Blue');
    expect(group.getAttribute('role')).toBe('Team Member');

    const status = root.getElementsByTagName('status')[0];
    expect(status.getAttribute('battery')).toBe('85');

    const track = root.getElementsByTagName('track')[0];
    expect(track.getAttribute('speed')).toBe('3');
    expect(track.getAttribute('course')).toBe('270');
  });

  it('omits __group/status/track when unknown', () => {
    const row = makeContact({ team: null, role: null, battery: null, speed: null, course: null });
    const xml = buildContactEvent(row, NOW)!;
    const root = parseEvent(xml);
    expect(root.getElementsByTagName('__group').length).toBe(0);
    expect(root.getElementsByTagName('status').length).toBe(0);
    expect(root.getElementsByTagName('track').length).toBe(0);
  });

  it('falls back callsign -> deviceCallsign -> uid', () => {
    const withCallsign = buildContactEvent(makeContact({ callsign: 'ALPHA-1' }), NOW)!;
    expect(parseEvent(withCallsign).getElementsByTagName('contact')[0].getAttribute('callsign')).toBe('ALPHA-1');

    const withDeviceOnly = buildContactEvent(makeContact({ callsign: null, deviceCallsign: 'EUD-9' }), NOW)!;
    expect(parseEvent(withDeviceOnly).getElementsByTagName('contact')[0].getAttribute('callsign')).toBe('EUD-9');

    const withUidOnly = buildContactEvent(makeContact({ callsign: null, deviceCallsign: null, uid: 'EUD-BARE' }), NOW)!;
    expect(parseEvent(withUidOnly).getElementsByTagName('contact')[0].getAttribute('callsign')).toBe('EUD-BARE');
  });

  it('returns null when there is no position', () => {
    expect(buildContactEvent(makeContact({ latitude: null, longitude: null }), NOW)).toBeNull();
  });

  it('returns null when already-stale (lastSeen older than 15 min)', () => {
    const stale = makeContact({ lastSeen: NOW - 16 * ONE_MIN });
    expect(buildContactEvent(stale, NOW)).toBeNull();
  });

  it('team/role enum maps to ATAK label strings', () => {
    const cyan = buildContactEvent(makeContact({ team: 10, role: 3 }), NOW)!;
    const group = parseEvent(cyan).getElementsByTagName('__group')[0];
    expect(group.getAttribute('name')).toBe('Cyan');
    expect(group.getAttribute('role')).toBe('HQ');
  });

  it('escapes an XML injection payload in the callsign (E5)', () => {
    const row = makeContact({ callsign: 'a"/><evil>' });
    const xml = buildContactEvent(row, NOW)!;
    const root = parseEvent(xml);
    expect(root.tagName).toBe('event');
    const contactEls = root.getElementsByTagName('contact');
    expect(contactEls.length).toBe(1);
    expect(contactEls[0].getAttribute('callsign')).toBe('a"/><evil>');
    expect(root.getElementsByTagName('evil').length).toBe(0);
  });

  it('escapes an XML injection payload in the uid attribute', () => {
    const row = makeContact({ uid: 'a"><evil attr="' });
    const xml = buildContactEvent(row, NOW)!;
    const root = parseEvent(xml);
    expect(root.getAttribute('uid')).toBe('a"><evil attr="');
    expect(root.getElementsByTagName('evil').length).toBe(0);
  });
});
