/**
 * MeshCore API Routes
 *
 * RESTful endpoints for MeshCore device interaction
 */

import { Router, Request, Response } from 'express';
import meshcoreManager, { ConnectionType, MeshCoreDeviceType } from '../meshcoreManager.js';
import { logger } from '../../utils/logger.js';

const router = Router();

/**
 * GET /api/meshcore/status
 * Get connection status and local node info
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = meshcoreManager.getConnectionStatus();
    const localNode = meshcoreManager.getLocalNode();

    res.json({
      success: true,
      data: {
        ...status,
        localNode,
        deviceTypeName: MeshCoreDeviceType[status.deviceType],
      },
    });
  } catch (error) {
    logger.error('[API] Error getting MeshCore status:', error);
    res.status(500).json({ success: false, error: 'Failed to get status' });
  }
});

/**
 * POST /api/meshcore/connect
 * Connect to a MeshCore device
 */
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { connectionType, serialPort, tcpHost, tcpPort, baudRate } = req.body;

    const config = {
      connectionType: connectionType as ConnectionType || ConnectionType.SERIAL,
      serialPort,
      tcpHost,
      tcpPort: tcpPort ? parseInt(tcpPort, 10) : 4403,
      baudRate: baudRate ? parseInt(baudRate, 10) : 115200,
    };

    const success = await meshcoreManager.connect(config);

    if (success) {
      res.json({
        success: true,
        message: 'Connected successfully',
        data: {
          localNode: meshcoreManager.getLocalNode(),
          deviceType: MeshCoreDeviceType[meshcoreManager.getConnectionStatus().deviceType],
        },
      });
    } else {
      res.status(400).json({ success: false, error: 'Connection failed' });
    }
  } catch (error) {
    logger.error('[API] Error connecting to MeshCore:', error);
    res.status(500).json({ success: false, error: 'Connection error' });
  }
});

/**
 * POST /api/meshcore/disconnect
 * Disconnect from the device
 */
router.post('/disconnect', async (_req: Request, res: Response) => {
  try {
    await meshcoreManager.disconnect();
    res.json({ success: true, message: 'Disconnected' });
  } catch (error) {
    logger.error('[API] Error disconnecting:', error);
    res.status(500).json({ success: false, error: 'Disconnect error' });
  }
});

/**
 * GET /api/meshcore/nodes
 * Get all known nodes (local + contacts)
 */
router.get('/nodes', async (_req: Request, res: Response) => {
  try {
    const nodes = meshcoreManager.getAllNodes();
    res.json({
      success: true,
      data: nodes,
      count: nodes.length,
    });
  } catch (error) {
    logger.error('[API] Error getting nodes:', error);
    res.status(500).json({ success: false, error: 'Failed to get nodes' });
  }
});

/**
 * GET /api/meshcore/contacts
 * Get contacts list
 */
router.get('/contacts', async (_req: Request, res: Response) => {
  try {
    const contacts = meshcoreManager.getContacts();
    const localNode = meshcoreManager.getLocalNode();

    // Include local node in contacts list if it has coordinates
    // Add small offset to prevent exact overlap with contacts at same location
    const allContacts = [...contacts];
    if (localNode && localNode.latitude && localNode.longitude) {
      allContacts.unshift({
        publicKey: localNode.publicKey,
        advName: `${localNode.name} (local)`,
        name: localNode.name,
        latitude: localNode.latitude + 0.0005,  // ~55m offset north
        longitude: localNode.longitude + 0.0005, // ~45m offset east
        advType: localNode.advType,
        rssi: undefined,
        snr: undefined,
        lastSeen: Date.now(),
      });
    }

    res.json({
      success: true,
      data: allContacts,
      count: allContacts.length,
    });
  } catch (error) {
    logger.error('[API] Error getting contacts:', error);
    res.status(500).json({ success: false, error: 'Failed to get contacts' });
  }
});

/**
 * POST /api/meshcore/contacts/refresh
 * Refresh contacts from device
 */
router.post('/contacts/refresh', async (_req: Request, res: Response) => {
  try {
    const contacts = await meshcoreManager.refreshContacts();
    res.json({
      success: true,
      data: Array.from(contacts.values()),
      count: contacts.size,
    });
  } catch (error) {
    logger.error('[API] Error refreshing contacts:', error);
    res.status(500).json({ success: false, error: 'Failed to refresh contacts' });
  }
});

/**
 * GET /api/meshcore/messages
 * Get recent messages
 */
router.get('/messages', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string || '50', 10);
    const messages = meshcoreManager.getRecentMessages(limit);
    res.json({
      success: true,
      data: messages,
      count: messages.length,
    });
  } catch (error) {
    logger.error('[API] Error getting messages:', error);
    res.status(500).json({ success: false, error: 'Failed to get messages' });
  }
});

/**
 * POST /api/meshcore/messages/send
 * Send a message
 */
router.post('/messages/send', async (req: Request, res: Response) => {
  try {
    const { text, toPublicKey } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, error: 'Message text required' });
    }

    const success = await meshcoreManager.sendMessage(text, toPublicKey);

    if (success) {
      res.json({ success: true, message: 'Message sent' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to send message' });
    }
  } catch (error) {
    logger.error('[API] Error sending message:', error);
    res.status(500).json({ success: false, error: 'Send error' });
  }
});

/**
 * POST /api/meshcore/advert
 * Send an advertisement
 */
router.post('/advert', async (_req: Request, res: Response) => {
  try {
    const success = await meshcoreManager.sendAdvert();

    if (success) {
      res.json({ success: true, message: 'Advert sent' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to send advert' });
    }
  } catch (error) {
    logger.error('[API] Error sending advert:', error);
    res.status(500).json({ success: false, error: 'Advert error' });
  }
});

/**
 * POST /api/meshcore/admin/login
 * Login to a remote node for admin access
 */
router.post('/admin/login', async (req: Request, res: Response) => {
  try {
    const { publicKey, password } = req.body;

    if (!publicKey || !password) {
      return res.status(400).json({ success: false, error: 'Public key and password required' });
    }

    const success = await meshcoreManager.loginToNode(publicKey, password);

    if (success) {
      res.json({ success: true, message: 'Login successful' });
    } else {
      res.status(401).json({ success: false, error: 'Login failed' });
    }
  } catch (error) {
    logger.error('[API] Error logging in:', error);
    res.status(500).json({ success: false, error: 'Login error' });
  }
});

/**
 * GET /api/meshcore/admin/status/:publicKey
 * Get status from a remote node (requires prior login)
 */
router.get('/admin/status/:publicKey', async (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;

    const status = await meshcoreManager.requestNodeStatus(publicKey);

    if (status) {
      res.json({ success: true, data: status });
    } else {
      res.status(404).json({ success: false, error: 'No status received' });
    }
  } catch (error) {
    logger.error('[API] Error getting node status:', error);
    res.status(500).json({ success: false, error: 'Status error' });
  }
});

/**
 * POST /api/meshcore/config/name
 * Set device name
 */
router.post('/config/name', async (req: Request, res: Response) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: 'Name required' });
    }

    const success = await meshcoreManager.setName(name);

    if (success) {
      res.json({ success: true, message: 'Name updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update name' });
    }
  } catch (error) {
    logger.error('[API] Error setting name:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

/**
 * POST /api/meshcore/config/radio
 * Set radio parameters
 */
router.post('/config/radio', async (req: Request, res: Response) => {
  try {
    const { freq, bw, sf, cr } = req.body;

    if (!freq || !bw || !sf || !cr) {
      return res.status(400).json({ success: false, error: 'All radio parameters required (freq, bw, sf, cr)' });
    }

    const success = await meshcoreManager.setRadio(
      parseFloat(freq),
      parseFloat(bw),
      parseInt(sf, 10),
      parseInt(cr, 10)
    );

    if (success) {
      res.json({ success: true, message: 'Radio config updated' });
    } else {
      res.status(400).json({ success: false, error: 'Failed to update radio config' });
    }
  } catch (error) {
    logger.error('[API] Error setting radio config:', error);
    res.status(500).json({ success: false, error: 'Config error' });
  }
});

export default router;
