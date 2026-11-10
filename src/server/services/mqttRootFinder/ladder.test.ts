import { describe, it, expect } from 'vitest';
import { buildLadder, buildCommunity, rankHeard, haversineKm, FLOOD_CAP, type HeardRoot } from './ladder.js';
import { getDirectory, MQTT_ROOTS_UPSTREAM_COMMIT } from './directory.js';

const dir = getDirectory();
const h = (root: string, nodes = 1, messages = 1, extra: Partial<HeardRoot> = {}): HeardRoot => ({
  root,
  nodes,
  messages,
  retainedOnly: false,
  ...extra,
});

describe('bundled directory', () => {
  it('loads and records its upstream SHA', () => {
    expect(dir.entries.length).toBeGreaterThan(10);
    expect(dir.neighbors['US-TX']).toContain('US-AR');
    expect(dir.subdivisionSegments.US.washington).toBe('WA');
    expect(MQTT_ROOTS_UPSTREAM_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('buildLadder', () => {
  const us = { cc: 'US', subdivisionName: 'Washington', subdivisionIso: 'US-WA', city: 'Seattle' };

  it('always offers the region and nothing else without a place', () => {
    const rows = buildLadder({ regionRoot: 'msh/US', heard: [h('msh/US/WA')], directory: dir });
    expect(rows.map((r) => r.root)).toEqual(['msh/US']);
  });

  it('never offers a doubled root like msh/US/US', () => {
    const rows = buildLadder({
      regionRoot: 'msh/US',
      place: us,
      heard: [h('msh/US/US', 3, 10), h('msh/US/US/WA', 3, 10)],
      directory: dir,
    });
    expect(rows.map((r) => r.root)).not.toContain('msh/US/US');
  });

  it('offers the country when heard and under the cap, before the subdivision', () => {
    const de = { cc: 'DE', subdivisionName: 'Bayern', subdivisionIso: 'DE-BY', city: 'München' };
    const rows = buildLadder({
      regionRoot: 'msh/EU_868',
      place: de,
      heard: [h('msh/EU_868/DE', 4, 20)],
      directory: dir,
    });
    const roots = rows.map((r) => r.root);
    expect(roots[0]).toBe('msh/EU_868');
    expect(roots[1]).toBe('msh/EU_868/DE');
    expect(roots[2]).toBe('msh/EU_868/DE/BY');
    expect(roots[3]).toBe('msh/EU_868/DE/BY/münchen');
  });

  it('skips the country when nobody uses the code', () => {
    const rows = buildLadder({ regionRoot: 'msh/EU_868', place: { cc: 'DE' }, heard: [h('msh/EU_868/FR')], directory: dir });
    expect(rows.map((r) => r.root)).toEqual(['msh/EU_868']);
  });

  it('uses a flooded country as prefix but does not offer it', () => {
    const rows = buildLadder({
      regionRoot: 'msh/EU_868',
      place: { cc: 'DE', subdivisionName: 'Bayern', subdivisionIso: 'DE-BY' },
      heard: [h('msh/EU_868/DE', 50, FLOOD_CAP, { floor: true })],
      directory: dir,
    });
    const roots = rows.map((r) => r.root);
    expect(roots).not.toContain('msh/EU_868/DE');
    expect(roots).toContain('msh/EU_868/DE/BY');
  });

  it('maps a subdivision name to its segment (R5) and lowercases the city', () => {
    const rows = buildLadder({ regionRoot: 'msh/US', place: us, heard: [], directory: dir });
    expect(rows.map((r) => r.root)).toContain('msh/US/WA');
    expect(rows.find((r) => r.kind === 'city')?.root).toBe('msh/US/WA/seattle');
  });

  it('trims city rows to 31 bytes on a code point boundary', () => {
    const rows = buildLadder({
      regionRoot: 'msh/US',
      place: { cc: 'US', subdivisionName: 'Washington', city: 'Llanfairpwllgwyngyllgogerychwyrndrobwll' },
      heard: [],
      directory: dir,
    });
    const city = rows.find((r) => r.kind === 'city')!;
    expect(new TextEncoder().encode(city.root).length).toBeLessThanOrEqual(31);
  });
});

describe('buildCommunity', () => {
  it('lists an unheard entry whose circle holds the user', () => {
    const rows = buildCommunity({
      regionRoot: 'msh/US',
      userPos: { lat: 41.9, lon: -87.9 },
      heard: [],
      directory: dir,
    });
    expect(rows.map((r) => r.root)).toContain('msh/US/IL/Chi');
    expect(rows.find((r) => r.root === 'msh/US/IL/Chi')?.heard).toBe(false);
  });

  it('lists entries that serve the user subdivision', () => {
    const rows = buildCommunity({
      regionRoot: 'msh/US',
      place: { cc: 'US', subdivisionName: 'Illinois', subdivisionIso: 'US-IL' },
      heard: [],
      directory: dir,
    });
    const roots = rows.map((r) => r.root);
    expect(roots).toContain('msh/US/IL/Chi');
    expect(roots).toContain('msh/US/IL/Central');
    expect(roots).not.toContain('msh/US/CA/socalmesh');
  });

  it('is empty with no place and no position', () => {
    expect(buildCommunity({ regionRoot: 'msh/US', heard: [], directory: dir })).toEqual([]);
  });

  it('marks heard entries', () => {
    const rows = buildCommunity({
      regionRoot: 'msh/US',
      userPos: { lat: 41.9, lon: -87.9 },
      heard: [h('msh/US/IL/Chi', 9, 99)],
      directory: dir,
    });
    expect(rows.find((r) => r.root === 'msh/US/IL/Chi')).toMatchObject({ heard: true, nodes: 9, messages: 99 });
  });
});

describe('rankHeard', () => {
  it('puts a neighbouring subdivision in tier 2 (Texarkana -> msh/US/AR)', () => {
    const ranked = rankHeard({
      regionRoot: 'msh/US',
      place: { cc: 'US', subdivisionName: 'Texas', subdivisionIso: 'US-TX' },
      userPos: { lat: 33.43, lon: -94.05 },
      heard: [h('msh/US/AR', 5, 50), h('msh/US/TX', 2, 5), h('msh/US/OR', 9, 90)],
      directory: dir,
    });
    expect(ranked.find((r) => r.root === 'msh/US/TX')?.tier).toBe(1);
    expect(ranked.find((r) => r.root === 'msh/US/AR')?.tier).toBe(2);
    expect(ranked.find((r) => r.root === 'msh/US/OR')?.tier).toBe(3);
    expect(ranked.map((r) => r.root)).toEqual(['msh/US/TX', 'msh/US/AR', 'msh/US/OR']);
  });

  it('puts roots under a community entry in tier 2', () => {
    const ranked = rankHeard({
      regionRoot: 'msh/US',
      userPos: { lat: 41.9, lon: -87.9 },
      heard: [h('msh/US/IL/Chi/north', 1, 1), h('msh/US/FL', 50, 500)],
      directory: dir,
    });
    expect(ranked[0]).toMatchObject({ root: 'msh/US/IL/Chi/north', tier: 2 });
  });

  it('orders nested republisher roots by depth', () => {
    const ranked = rankHeard({
      regionRoot: 'msh/US',
      heard: [h('msh/US/CA/US/MI', 50, 500), h('msh/US/CA', 1, 1), h('msh/US/CA/US', 2, 2)],
      directory: dir,
    });
    expect(ranked.map((r) => r.root)).toEqual(['msh/US/CA', 'msh/US/CA/US', 'msh/US/CA/US/MI']);
  });

  it('breaks ties by distance, then nodes, then messages, then name', () => {
    const userPos = { lat: 40, lon: -100 };
    const far = h('msh/US/BB', 1, 1, { positions: [{ lat: 45, lon: -100 }] });
    const near = h('msh/US/AA', 1, 1, { positions: [{ lat: 40.1, lon: -100 }] });
    const noPos = h('msh/US/ZZ', 99, 99);
    expect(
      rankHeard({ regionRoot: 'msh/US', userPos, heard: [noPos, far, near], directory: dir }).map((r) => r.root),
    ).toEqual(['msh/US/AA', 'msh/US/BB', 'msh/US/ZZ']);

    const byNodes = rankHeard({
      regionRoot: 'msh/US',
      heard: [h('msh/US/B', 1, 9), h('msh/US/A', 5, 1)],
      directory: dir,
    });
    expect(byNodes.map((r) => r.root)).toEqual(['msh/US/A', 'msh/US/B']);

    const byMsgs = rankHeard({
      regionRoot: 'msh/US',
      heard: [h('msh/US/B', 2, 1), h('msh/US/A', 2, 9)],
      directory: dir,
    });
    expect(byMsgs.map((r) => r.root)).toEqual(['msh/US/A', 'msh/US/B']);

    const byName = rankHeard({
      regionRoot: 'msh/US',
      heard: [h('msh/US/B', 2, 2), h('msh/US/A', 2, 2)],
      directory: dir,
    });
    expect(byName.map((r) => r.root)).toEqual(['msh/US/A', 'msh/US/B']);
  });

  it('returns only a rounded km distance, never a coordinate', () => {
    const ranked = rankHeard({
      regionRoot: 'msh/US',
      userPos: { lat: 40, lon: -100 },
      heard: [h('msh/US/AA', 1, 1, { positions: [{ lat: 40.5, lon: -100 }] })],
      directory: dir,
    });
    expect(ranked[0].nearestKm).toBe(Math.round(haversineKm({ lat: 40, lon: -100 }, { lat: 40.5, lon: -100 })));
    expect(JSON.stringify(ranked)).not.toContain('40.5');
    expect(ranked[0]).not.toHaveProperty('positions');
  });
});
