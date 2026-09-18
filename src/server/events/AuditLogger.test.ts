import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { EventBus } from './EventBus.js';
import { AuditLogger, formatAuditLine } from './AuditLogger.js';
import type { DbMessage, DbChannel, DbTraceroute } from '../../services/database.js';

describe('formatAuditLine', () => {
  it('formatiert ISO-Timestamp, Typ, Source und Key-Value-Paare', () => {
    const line = formatAuditLine('node:updated', 'src-a', {
      nodeNum: '123',
      longName: 'Test Node',
    });

    expect(line).toContain('node:updated');
    expect(line).toContain('source=src-a');
    expect(line).toContain('nodeNum=123');
    expect(line).toContain('longName=Test Node');
    // ISO timestamp am Anfang
    expect(line.startsWith('[')).toBe(true);
  });

  it('lässt leere Werte weg und verwendet __default__ ohne sourceId', () => {
    const line = formatAuditLine('routing:update', undefined, {
      requestId: '7',
      status: 'ack',
      fromNodeNum: '',
    });

    expect(line).toContain('source=__default__');
    expect(line).toContain('requestId=7');
    expect(line).not.toContain('fromNodeNum');
  });
});

describe('AuditLogger', () => {
  let emitter: EventEmitter;
  let bus: EventBus;
  let auditLogger: AuditLogger;
  let writeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emitter = new EventEmitter();
    bus = new EventBus(emitter);
    writeSpy = vi.fn();
    auditLogger = new AuditLogger(bus, writeSpy);
    auditLogger.start();
  });

  afterEach(() => {
    auditLogger.stop();
  });

  it('schreibt einen Eintrag pro node:updated Event', () => {
    emitter.emit('data', {
      type: 'node:updated',
      data: { nodeNum: 123, node: { longName: 'Test Node' } },
      timestamp: 1_700_000_000_000,
      sourceId: 'src-a',
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [line] = writeSpy.mock.calls[0] as [string];
    expect(line).toContain('node:updated');
    expect(line).toContain('src-a');
    expect(line).toContain('123');
    expect(line).toContain('Test Node');
  });

  it('schreibt einen Eintrag pro message:new Event', () => {
    const message = {
      id: 'msg-1',
      fromNodeNum: 99,
      toNodeNum: 100,
      text: 'hi',
    } as unknown as DbMessage;

    emitter.emit('data', {
      type: 'message:new',
      data: message,
      timestamp: 1_700_000_001_000,
      sourceId: 'src-b',
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [line] = writeSpy.mock.calls[0] as [string];
    expect(line).toContain('message:new');
    expect(line).toContain('src-b');
    expect(line).toContain('99');
    expect(line).toContain('100');
  });

  it('schreibt einen Eintrag pro connection:status Event', () => {
    emitter.emit('data', {
      type: 'connection:status',
      data: { connected: true, nodeNum: 42 },
      timestamp: 1_700_000_002_000,
      sourceId: 'src-c',
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [line] = writeSpy.mock.calls[0] as [string];
    expect(line).toContain('connection:status');
    expect(line).toContain('connected=true');
  });

  it('schreibt einen Eintrag pro channel:updated Event', () => {
    const channel = {
      id: 5,
      name: 'gauntlet',
      uplinkEnabled: true,
      downlinkEnabled: true,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as DbChannel;

    emitter.emit('data', {
      type: 'channel:updated',
      data: channel,
      timestamp: 1_700_000_006_000,
      sourceId: 'src-f',
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [line] = writeSpy.mock.calls[0] as [string];
    expect(line).toContain('channel:updated');
    expect(line).toContain('gauntlet');
  });

  it('schreibt einen Eintrag pro traceroute:complete Event', () => {
    const traceroute = {
      fromNodeNum: 1,
      toNodeNum: 2,
    } as unknown as DbTraceroute;

    emitter.emit('data', {
      type: 'traceroute:complete',
      data: traceroute,
      timestamp: 1_700_000_007_000,
      sourceId: 'src-g',
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [line] = writeSpy.mock.calls[0] as [string];
    expect(line).toContain('traceroute:complete');
  });

  it('schreibt KEINEN Eintrag für nicht-audierte Event-Typen (telemetry:batch)', () => {
    emitter.emit('data', {
      type: 'telemetry:batch',
      data: {},
      timestamp: 1_700_000_003_000,
      sourceId: 'src-d',
    });

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('stop() beendet die Subscription — weitere Events werden nicht geloggt', () => {
    auditLogger.stop();
    emitter.emit('data', {
      type: 'node:updated',
      data: { nodeNum: 1, node: {} },
      timestamp: 1_700_000_004_000,
      sourceId: 'src-x',
    });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('start() ist idempotent — zweiter Aufruf loggt nicht doppelt', () => {
    auditLogger.start();
    emitter.emit('data', {
      type: 'node:updated',
      data: { nodeNum: 2, node: {} },
      timestamp: 1_700_000_005_000,
      sourceId: 'src-y',
    });
    // trotz doppeltem start(): genau eine Zeile
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
