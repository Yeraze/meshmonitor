import { Router, Request, Response } from 'express';
import { optionalAuth, requireAdmin } from '../auth/authMiddleware.js';
import { logger } from '../../utils/logger.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';

const router = Router();

// Check if TX is disabled
router.get('/device/tx-status', optionalAuth(), async (req: Request, res: Response) => {
  try {
    const txSourceId = req.query.sourceId as string | undefined;
    const txManager = resolveSourceManager(txSourceId);
    const deviceConfig = await txManager.getDeviceConfig();
    const txEnabled = deviceConfig?.lora?.txEnabled !== false; // Default to true if undefined
    // UDP-broadcast relay (#4394): with `network.enabledProtocols & UDP_BROADCAST`
    // set, firmware still emits outgoing packets onto the LAN even when the radio
    // is TX-disabled, and a peer there relays them onto the mesh. Such a source can
    // send, so the UI gates on `canTransmit`, not on `txEnabled` alone. Managers
    // without the method (non-Meshtastic) report no relay.
    const udpRelayEnabled = typeof txManager.isUdpBroadcastRelayEnabled === 'function'
      ? txManager.isUdpBroadcastRelayEnabled()
      : false;
    res.json({ txEnabled, udpRelayEnabled, canTransmit: txEnabled || udpRelayEnabled });
  } catch (error) {
    logger.error('Error getting TX status:', error);
    res.status(500).json({ error: 'Failed to get TX status' });
  }
});

// Get security keys (public and private) for the local node.
// MM-SEC-5: gated on `requireAdmin()` because the response includes the
// device's PKI private key. Any holder of that key can decrypt PKI DMs the
// local node receives and forge signed packets from it.
router.get('/device/security-keys', requireAdmin(), async (req: Request, res: Response) => {
  try {
    const skSourceId = req.query.sourceId as string | undefined;
    const skManager = resolveSourceManager(skSourceId);
    const keys = skManager.getSecurityKeys();
    res.json(keys);
  } catch (error) {
    logger.error('Error getting security keys:', error);
    res.status(500).json({ error: 'Failed to get security keys' });
  }
});

export default router;
