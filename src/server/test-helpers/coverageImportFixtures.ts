/**
 * Shared fixtures for the coverage import route tests (#5891 P3 WP3):
 * reception DTOs and the real CSV / GeoJSON export builders.
 */
import { buildCoverageCsv, buildCoverageGeoJson } from '../../utils/coverageExport.js';
import type { CoverageReceptionDto } from '../../types/coverage.js';
import type { CoverageExportContext } from '../../types/coverageAnalysis.js';

export const MT_RECEIVER_NUM = 0xaaaa0001;
export const MT_SENDER_NUM = 0xbbbb0001;
export const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;
export const MC_RECEIVER = 'c1'.repeat(32);
export const MC_SENDER = 'd2'.repeat(32);

export function mtDto(i: number, o: Partial<CoverageReceptionDto> = {}): CoverageReceptionDto {
  return {
    id: i,
    sourceId: 'origin',
    protocol: 'meshtastic',
    receiverKind: 'local',
    receiverId: nodeIdFor(MT_RECEIVER_NUM),
    receiverNodeNum: MT_RECEIVER_NUM,
    receiverLatitude: 10.5,
    receiverLongitude: 20.5,
    senderId: nodeIdFor(MT_SENDER_NUM),
    senderNodeNum: MT_SENDER_NUM,
    packetKey: String(1000 + i),
    packetId: 1000 + i,
    pathKey: 'r0:h0',
    latitude: 30 + i * 0.001,
    longitude: -90,
    altitude: null,
    precisionBits: null,
    snr: 5.5 - (i % 100) * 0.25,
    rssi: -90,
    hopStart: 3,
    hopLimit: 3,
    hopsAway: 0,
    relayNode: null,
    transportMechanism: null,
    channel: 0,
    rxTime: null,
    receivedAt: Date.now() - 60_000 * (i + 1),
    ...o,
  };
}

export function mcDto(i: number, o: Partial<CoverageReceptionDto> = {}): CoverageReceptionDto {
  return mtDto(i, {
    protocol: 'meshcore',
    receiverId: MC_RECEIVER,
    receiverNodeNum: null,
    senderId: MC_SENDER,
    senderNodeNum: null,
    packetKey: (0xabcdef0100 + i).toString(16).toUpperCase().padStart(16, '0'),
    packetId: null,
    pathKey: 'h2:ab',
    hopStart: null,
    hopLimit: null,
    hopsAway: 2,
    channel: null,
    ...o,
  });
}

export const exportCtx = (): CoverageExportContext => ({
  senderNames: new Map(),
  receiverNames: new Map(),
  sourceNames: new Map(),
  truncated: false,
  generatedAt: Date.now(),
  filters: {},
});

export const csvOf = (items: CoverageReceptionDto[]): string => buildCoverageCsv(items, exportCtx());
export const geoOf = (items: CoverageReceptionDto[]): string => buildCoverageGeoJson(items, exportCtx());

/** POST helper: raw octet-stream body with the X-Filename header. */
export function uploadTo(
  agent: { post(url: string): any }, // eslint-disable-line @typescript-eslint/no-explicit-any -- supertest agent
  sourceId: string,
  filename: string,
  body: string | Buffer,
) {
  return agent
    .post(`/api/sources/${sourceId}/coverage/imports`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Filename', encodeURIComponent(filename))
    .send(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
}
