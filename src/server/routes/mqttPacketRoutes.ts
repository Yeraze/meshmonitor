/**
 * MQTT Packet Monitor API Routes
 *
 * Mounted under `/api/sources/:id/mqtt/packets` (`Router({ mergeParams: true })`
 * so `req.params.id` is always present). Grouped (deduplicated) packet list,
 * per-gateway detail lookup, gateway summary, and log clearing for the MQTT
 * packet monitor (Phase 1). Mirrors the MeshCore packet monitor's
 * `/packets` routes in `meshcoreRoutes.ts` for handler shape and auth pattern.
 *
 * Deliberately does NOT check the source's type (no MQTT-manager lookup):
 * the `packetmonitor` permission is already per-source scoped, and requiring
 * a live/connected MQTT manager would hide retained rows for a temporarily
 * disconnected or reconfigured source. A non-MQTT source simply has no rows.
 * See docs/internal/dev-notes/MQTT_PACKET_MONITOR_PHASE1_SPEC.md §2.11.
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { requireAuth, optionalAuth, requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import mqttPacketLogService from '../services/mqttPacketLogService.js';

const router = Router({ mergeParams: true });

const MQTT_PACKET_MAX_LIMIT = 1000;

/**
 * Fire-and-forget audit log helper for MQTT packet-monitor admin actions.
 * Copied from `auditMeshcoreEvent` (`meshcoreRoutes.ts`) — errors from the
 * audit write itself are swallowed so losing a single audit row never fails
 * the request the user cares about.
 */
function auditMqttEvent(req: Request, action: string, details: Record<string, unknown>): void {
  const userId = req.session?.userId ?? null;
  const ip = req.ip || req.socket?.remoteAddress || null;
  databaseService
    .auditLogAsync(userId, action, 'configuration', JSON.stringify(details), ip)
    .catch((err) => logger.error('[API] audit write failed:', err));
}

/**
 * GET /api/sources/:id/mqtt/packets
 *
 * Grouped (deduplicated) packet list — one row per `(fromNode, packetId)`
 * group, collapsing per-gateway receptions, newest-first. Filters:
 * gateways (CSV of gatewayId), portnum, since (s or ms), encrypted.
 */
router.get(
  '/',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

      const maxCount = await mqttPacketLogService.getMaxCount();
      const requestedLimit = parseInt(req.query.limit as string, 10);
      const effectiveLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : maxCount;
      const limit = Math.min(Math.max(effectiveLimit, 1), MQTT_PACKET_MAX_LIMIT);

      const gatewaysRaw = typeof req.query.gateways === 'string' ? req.query.gateways : undefined;
      const gateways = gatewaysRaw
        ? gatewaysRaw.split(',').map((g) => g.trim()).filter((g) => g.length > 0)
        : undefined;

      const portnumRaw = req.query.portnum !== undefined ? parseInt(req.query.portnum as string, 10) : undefined;
      const portnum = Number.isFinite(portnumRaw as number) ? portnumRaw : undefined;

      let since = req.query.since !== undefined ? parseInt(req.query.since as string, 10) : undefined;
      if (since !== undefined && Number.isFinite(since) && since < 1e12) since = since * 1000;
      if (since !== undefined && !Number.isFinite(since)) since = undefined;

      const encryptedRaw = req.query.encrypted;
      let encrypted: boolean | undefined;
      if (encryptedRaw === '1' || encryptedRaw === 'true') encrypted = true;
      else if (encryptedRaw === '0' || encryptedRaw === 'false') encrypted = false;

      const q = {
        sourceId,
        gateways: gateways && gateways.length > 0 ? gateways : undefined,
        portnum,
        since,
        encrypted,
        limit,
        offset,
      };

      const [packets, total, enabled, maxAgeHours] = await Promise.all([
        mqttPacketLogService.getGroupedPackets(q),
        mqttPacketLogService.getGroupedPacketCount(q),
        mqttPacketLogService.isEnabled(),
        mqttPacketLogService.getMaxAgeHours(),
      ]);

      ok(res, { packets, total, offset, limit, enabled, maxCount, maxAgeHours });
    } catch (error) {
      logger.error('[API] Error fetching MQTT packets:', error);
      fail(res, 500, 'MQTT_PACKETS_FETCH_FAILED', 'Failed to fetch packets');
    }
  },
);

/**
 * GET /api/sources/:id/mqtt/packets/gateways
 *
 * Distinct gateways that have reported for this source, with reception
 * count and last-heard time — powers the gateway filter UI.
 */
router.get(
  '/gateways',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const gateways = await mqttPacketLogService.getGateways(sourceId);
      ok(res, { gateways });
    } catch (error) {
      logger.error('[API] Error fetching MQTT gateways:', error);
      fail(res, 500, 'MQTT_GATEWAYS_FETCH_FAILED', 'Failed to fetch gateways');
    }
  },
);

/**
 * GET /api/sources/:id/mqtt/packets/receptions?packetId=&fromNode=
 *
 * Per-gateway reception detail for one packet group, oldest-first.
 */
router.get(
  '/receptions',
  optionalAuth(),
  requirePermission('packetmonitor', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const packetId = parseInt(req.query.packetId as string, 10);
      const fromNode = parseInt(req.query.fromNode as string, 10);
      if (!Number.isFinite(packetId) || !Number.isFinite(fromNode)) {
        fail(res, 400, 'MISSING_PACKET_KEY', 'packetId and fromNode are required');
        return;
      }
      const receptions = await mqttPacketLogService.getReceptions(sourceId, packetId, fromNode);
      ok(res, { receptions });
    } catch (error) {
      logger.error('[API] Error fetching MQTT receptions:', error);
      fail(res, 500, 'MQTT_RECEPTIONS_FETCH_FAILED', 'Failed to fetch receptions');
    }
  },
);

/**
 * DELETE /api/sources/:id/mqtt/packets
 *
 * Clear this source's MQTT packet reception log. Requires packetmonitor:write.
 */
router.delete(
  '/',
  requireAuth(),
  requirePermission('packetmonitor', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = (req.params as { id?: string }).id!;
      const deleted = await mqttPacketLogService.clearPackets(sourceId);
      auditMqttEvent(req, 'mqtt_packets_cleared', { sourceId, deleted });
      ok(res, { deleted });
    } catch (error) {
      logger.error('[API] Error clearing MQTT packets:', error);
      fail(res, 500, 'MQTT_PACKETS_CLEAR_FAILED', 'Failed to clear packets');
    }
  },
);

export default router;
