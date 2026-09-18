/**
 * AuditLogger
 *
 * First subscriber on the EventBus. Writes one structured line per
 * whitelisted event type to an injected write function (`AuditWriteFn`).
 *
 * The production binding (rotating-file-stream) lives in `index.ts`
 * (`createAuditLogger()`), so this class stays free of I/O and is
 * trivially testable with a spy.
 *
 * Event types logged (whitelist, not blacklist):
 *   node:updated, node:mobility, message:new, channel:updated,
 *   connection:status, traceroute:complete, routing:update
 *
 * Not logged (YAGNI / volume):
 *   telemetry:batch, auto-ping:update, client-notification,
 *   waypoint:*, meshcore:*, reticulum:*, meshbeacon:received
 */

import type { EventBus } from './EventBus.js';
import { logger } from '../../utils/logger.js';

/**
 * Write a single audit line to the target stream.
 */
export type AuditWriteFn = (line: string) => void;

/**
 * Format a single audit line:
 * `[ISO timestamp] <event type> source=<sourceId> k1=v1 k2=v2 …`
 *
 * Empty values are dropped. `sourceId` defaults to `__default__`.
 */
export function formatAuditLine(
  type: string,
  sourceId: string | undefined,
  fields: Record<string, string>,
): string {
  const ts = new Date().toISOString();
  const src = sourceId ?? '__default__';
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return `[${ts}] ${type} source=${src} ${kv}`.trim();
}

/**
 * Subscribes to the EventBus and writes audit lines for the 7
 * whitelisted event types.
 */
export class AuditLogger {
  private offFns: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly bus: EventBus,
    private readonly write: AuditWriteFn,
  ) {}

  /**
   * Subscribe to the whitelisted event types.
   * Idempotent: a second call while running is a no-op (with a warning).
   */
  start(): void {
    if (this.running) {
      logger.warn('[AuditLogger] already running — ignoring duplicate start()');
      return;
    }
    this.running = true;

    this.offFns.push(
      this.bus.on('node:updated', (data, sourceId) => {
        this.write(
          formatAuditLine('node:updated', sourceId, {
            nodeNum: String(data.nodeNum),
            longName: data.node?.longName ?? '',
          }),
        );
      }),
    );

    this.offFns.push(
      this.bus.on('node:mobility', (data, sourceId) => {
        this.write(
          formatAuditLine('node:mobility', sourceId, {
            nodeNum: String(data.nodeNum),
            transition: `${data.previous}->${data.current}`,
          }),
        );
      }),
    );

    this.offFns.push(
      this.bus.on('message:new', (data, sourceId) => {
        this.write(
          formatAuditLine('message:new', sourceId, {
            from: String(data.fromNodeNum ?? '?'),
            to: String(data.toNodeNum ?? '?'),
            channel: String(data.channel ?? ''),
          }),
        );
      }),
    );

    this.offFns.push(
      this.bus.on('channel:updated', (data, sourceId) => {
        this.write(
          formatAuditLine('channel:updated', sourceId, {
            id: String(data.id ?? '?'),
            name: data.name ?? '',
          }),
        );
      }),
    );

    this.offFns.push(
      this.bus.on('connection:status', (data, sourceId) => {
        this.write(
          formatAuditLine('connection:status', sourceId, {
            connected: String(data.connected),
            nodeNum: data.nodeNum != null ? String(data.nodeNum) : '',
            reason: data.reason ?? '',
          }),
        );
      }),
    );

    this.offFns.push(
      this.bus.on('traceroute:complete', (data, sourceId) => {
        this.write(
          formatAuditLine('traceroute:complete', sourceId, {
            from: String(data.fromNodeNum ?? '?'),
            to: String(data.toNodeNum ?? '?'),
          }),
        );
      }),
    );

    this.offFns.push(
      this.bus.on('routing:update', (data, sourceId) => {
        this.write(
          formatAuditLine('routing:update', sourceId, {
            requestId: String(data.requestId ?? '?'),
            status: data.status,
            fromNodeNum: data.fromNodeNum != null ? String(data.fromNodeNum) : '',
          }),
        );
      }),
    );

    logger.info('[AuditLogger] started — subscribed to 7 event types');
  }

  /**
   * Unsubscribe all handlers. Idempotent.
   */
  stop(): void {
    if (!this.running) return;
    this.offFns.forEach((off) => off());
    this.offFns = [];
    this.running = false;
    logger.info('[AuditLogger] stopped');
  }
}
