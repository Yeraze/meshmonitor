/**
 * MeshBeacon Offer API Routes (#4723)
 *
 * Mounted under `/api/sources/:id/beacon-offers` (`Router({ mergeParams: true })`
 * so `req.params.id` is always present). Serves the per-source
 * `mesh_beacon_offers` table populated by `meshBeaconOfferService`.
 *
 * **The offered channel key never leaves this process.** Listings go through
 * `toPublicOffer`, which replaces the PSK with a `hasChannelKey` boolean. That
 * is the reason `accept` is a server-side endpoint at all rather than the client
 * resolving a slot and calling the existing `PUT /api/channels/:id` route — the
 * client has no key to send.
 *
 * **Accepting is a device write, and is guarded like one:**
 * - `confirm: true` is required in the body. The UI shows a confirmation dialog
 *   (maintainer decision on #4723), but making it a protocol requirement means
 *   nothing can drive the endpoint as a bare one-click — an API token, a stale
 *   tab replaying a request, or a future caller that forgets the dialog.
 * - the caller needs `channel_<slot>:write` for the SPECIFIC destination slot,
 *   the same per-channel gate `PUT /api/channels/:id` enforces.
 * - slot 0 is refused outright: it is the primary channel, and joining an
 *   invitation must never silently move the node off its own network.
 * - a slot that already holds a configured channel needs `overwrite: true` on
 *   top of `confirm`, so "I meant to accept" and "I meant to destroy what was
 *   in slot 3" are two separate statements.
 */

import { Router, Request, Response } from 'express';
import databaseService from '../../services/database.js';
import { toPublicOffer } from '../../db/repositories/meshBeaconOffers.js';
import { logger } from '../../utils/logger.js';
import { optionalAuth, requireAuth, requirePermission, hasPermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import type { ResourceType } from '../../types/permission.js';

const router = Router({ mergeParams: true });

/** Meshtastic exposes 8 channel slots; 0 is the primary and is not a join target. */
const MAX_CHANNEL_SLOT = 7;

const sourceIdOf = (req: Request): string => (req.params as { id?: string }).id!;

/** `:nodeNum` as an unsigned 32-bit number, or null when unparseable. */
function parseNodeNum(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 0xffffffff ? n : null;
}

/**
 * GET /api/sources/:id/beacon-offers
 *
 * Pending offers by default; `?includeDismissed=true` returns the full set so a
 * user can find something they dismissed by accident. PSK stripped either way.
 */
router.get(
  '/',
  optionalAuth(),
  requirePermission('nodes', 'read', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const sourceId = sourceIdOf(req);
      const includeDismissed = req.query.includeDismissed === 'true';
      const rows = includeDismissed
        ? await databaseService.meshBeaconOffers.listAll(sourceId)
        : await databaseService.meshBeaconOffers.listPending(sourceId);
      ok(res, rows.map(toPublicOffer));
    } catch (error) {
      logger.error('[API] Error fetching beacon offers:', error);
      fail(res, 500, 'BEACON_OFFERS_FETCH_FAILED', 'Failed to fetch beacon offers');
    }
  },
);

/**
 * POST /api/sources/:id/beacon-offers/:nodeNum/dismiss
 *
 * Hides the offer until the advertising node changes what it advertises.
 */
router.post(
  '/:nodeNum/dismiss',
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const nodeNum = parseNodeNum(req.params.nodeNum);
      if (nodeNum == null) return fail(res, 400, 'INVALID_NODE_NUM', 'Invalid node number');

      const changed = await databaseService.meshBeaconOffers.dismiss(sourceIdOf(req), nodeNum, Date.now());
      if (!changed) return fail(res, 404, 'BEACON_OFFER_NOT_FOUND', 'No beacon offer from that node on this source');
      ok(res);
    } catch (error) {
      logger.error('[API] Error dismissing beacon offer:', error);
      fail(res, 500, 'BEACON_OFFER_DISMISS_FAILED', 'Failed to dismiss beacon offer');
    }
  },
);

/** POST /api/sources/:id/beacon-offers/:nodeNum/restore — undo a dismissal. */
router.post(
  '/:nodeNum/restore',
  requireAuth(),
  requirePermission('nodes', 'write', { sourceIdFrom: 'params.id' }),
  async (req: Request, res: Response) => {
    try {
      const nodeNum = parseNodeNum(req.params.nodeNum);
      if (nodeNum == null) return fail(res, 400, 'INVALID_NODE_NUM', 'Invalid node number');

      const changed = await databaseService.meshBeaconOffers.restore(sourceIdOf(req), nodeNum);
      if (!changed) return fail(res, 404, 'BEACON_OFFER_NOT_FOUND', 'No beacon offer from that node on this source');
      ok(res);
    } catch (error) {
      logger.error('[API] Error restoring beacon offer:', error);
      fail(res, 500, 'BEACON_OFFER_RESTORE_FAILED', 'Failed to restore beacon offer');
    }
  },
);

/**
 * POST /api/sources/:id/beacon-offers/:nodeNum/accept
 *
 * Body: `{ slot: number, confirm: true, overwrite?: boolean }`
 *
 * Writes the offered channel into `slot` on the device, then dismisses the
 * offer (it has been acted on; leaving it pending would re-invite the user to
 * join a channel they are already on).
 *
 * Only the channel is applied. A beacon may also advertise a region and modem
 * preset, but those are LoRa config — a whole-struct replace that moves the
 * radio to a different network entirely. The firmware never auto-applies an
 * offer, and neither does this.
 */
router.post(
  '/:nodeNum/accept',
  requireAuth(),
  async (req: Request, res: Response) => {
    try {
      const sourceId = sourceIdOf(req);
      const nodeNum = parseNodeNum(req.params.nodeNum);
      if (nodeNum == null) return fail(res, 400, 'INVALID_NODE_NUM', 'Invalid node number');

      const { slot, confirm, overwrite } = req.body ?? {};

      // Explicit confirmation, enforced server-side rather than trusted to the
      // dialog. This is a radio write; it should not be reachable by accident.
      if (confirm !== true) {
        return fail(res, 400, 'CONFIRMATION_REQUIRED',
          'Accepting a beacon offer writes a channel to the radio and requires explicit confirmation.');
      }

      if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot > MAX_CHANNEL_SLOT) {
        return fail(res, 400, 'INVALID_CHANNEL_SLOT', `Channel slot must be an integer between 0 and ${MAX_CHANNEL_SLOT}`);
      }
      if (slot === 0) {
        return fail(res, 400, 'PRIMARY_SLOT_PROTECTED',
          'Slot 0 is the primary channel. Accepting an invitation into it would move this node off its own network — choose another slot.');
      }

      // Per-slot write gate, matching PUT /api/channels/:id. A user trusted to
      // edit channel 3 is not thereby trusted to edit channel 5.
      const channelResource = `channel_${slot}` as ResourceType;
      if (!req.user?.isAdmin && !(req.user && await hasPermission(req.user, channelResource, 'write', sourceId))) {
        return fail(res, 403, 'FORBIDDEN', 'Insufficient permissions', {
          required: { resource: channelResource, action: 'write' },
        });
      }

      const offer = await databaseService.meshBeaconOffers.getOffer(sourceId, nodeNum);
      if (!offer) return fail(res, 404, 'BEACON_OFFER_NOT_FOUND', 'No beacon offer from that node on this source');

      const channelName = offer.offerChannelName?.trim();
      if (!channelName) {
        return fail(res, 422, 'OFFER_HAS_NO_CHANNEL',
          'This beacon does not advertise a channel, so there is nothing to join.');
      }
      if (!offer.offerChannelPsk) {
        // Guarded here as well as in the UI: a name-only offer would produce a
        // channel that cannot decrypt anything, which looks like success.
        return fail(res, 422, 'OFFER_HAS_NO_KEY',
          'The beacon named a channel but did not include its key, so the channel could not decrypt anything.');
      }

      // Refuse to clobber a configured slot unless that was said out loud.
      // role 0 (DISABLED) with no name is an empty slot; anything else is in use.
      const existing = await databaseService.channels.getChannelById(slot, sourceId);
      const slotInUse = Boolean(existing && (existing.name || (existing.role ?? 0) !== 0));
      if (slotInUse && overwrite !== true) {
        return fail(res, 409, 'CHANNEL_SLOT_IN_USE',
          `Channel slot ${slot} already holds "${existing?.name || 'an unnamed channel'}". Re-send with overwrite to replace it.`, {
            occupiedBy: existing?.name ?? null,
          });
      }

      const channelData = {
        id: slot,
        name: channelName,
        psk: offer.offerChannelPsk,
        // Secondary: an accepted invitation joins alongside the existing
        // primary rather than becoming this node's own primary network.
        role: 2,
        uplinkEnabled: false,
        downlinkEnabled: false,
        positionPrecision: existing?.positionPrecision ?? null,
      };

      // Push to the device FIRST. If the radio rejects the write, the DB must
      // not be left claiming a channel the node does not actually have — the
      // opposite order would show the user a channel that silently receives
      // nothing.
      const manager = resolveSourceManager(sourceId);
      try {
        await manager.setChannelConfig(slot, {
          name: channelData.name,
          psk: channelData.psk,
          role: channelData.role,
          uplinkEnabled: channelData.uplinkEnabled,
          downlinkEnabled: channelData.downlinkEnabled,
          positionPrecision: channelData.positionPrecision ?? undefined,
        });
      } catch (deviceError) {
        logger.error(`[API] Failed to write accepted beacon channel to slot ${slot}:`, deviceError);
        return fail(res, 502, 'CHANNEL_WRITE_FAILED',
          `Failed to write channel "${channelName}" to the radio. Nothing was changed.`, {
            detail: deviceError instanceof Error ? deviceError.message : String(deviceError),
          });
      }

      await databaseService.channels.upsertChannel(channelData, sourceId, { allowBlankName: true });

      // The offer has been acted on — keep it from re-inviting the user to a
      // channel they are now on.
      await databaseService.meshBeaconOffers.dismiss(sourceId, nodeNum, Date.now());

      logger.info(`Accepted beacon offer from ${nodeNum}: joined "${channelName}" in slot ${slot} on source ${sourceId}`);
      ok(res, { slot, name: channelName });
    } catch (error) {
      logger.error('[API] Error accepting beacon offer:', error);
      fail(res, 500, 'BEACON_OFFER_ACCEPT_FAILED', 'Failed to accept beacon offer');
    }
  },
);

export default router;
