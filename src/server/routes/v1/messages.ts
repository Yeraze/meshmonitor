/**
 * API v1 - Messages Routes
 *
 * Read-only endpoints for message history
 */

import express, { Request, Response } from 'express';
import databaseService from '../../../services/database.js';
import meshtasticManager from '../../meshtasticManager.js';
import { requirePermission } from '../../auth/authMiddleware.js';
import { logger } from '../../../utils/logger.js';

const router = express.Router();

/**
 * @openapi
 * /messages:
 *   get:
 *     tags: [Messages]
 *     summary: Get recent messages
 *     description: Returns recent messages from all channels
 *     parameters:
 *       - name: limit
 *         in: query
 *         description: Maximum number of messages to return
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 500
 *       - name: offset
 *         in: query
 *         description: Number of messages to skip (for pagination)
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: List of messages
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Message'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/', requirePermission('messages', 'read'), (req: Request, res: Response) => {
  try {
    const limitParam = req.query.limit;
    const offsetParam = req.query.offset;
    const limit = limitParam ? Math.min(parseInt(limitParam as string), 500) : 50;
    const offset = offsetParam ? parseInt(offsetParam as string) : 0;

    const messages = meshtasticManager.getRecentMessages(limit + offset);
    const paginatedMessages = messages.slice(offset, offset + limit);

    res.json(paginatedMessages);
  } catch (error) {
    logger.error('Error fetching messages:', error);
    res.status(500).json({
      error: 'Failed to fetch messages',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @openapi
 * /messages/channel/{channel}:
 *   get:
 *     tags: [Messages]
 *     summary: Get messages by channel
 *     description: Returns messages from a specific channel
 *     parameters:
 *       - name: channel
 *         in: path
 *         required: true
 *         description: Channel index (0-7)
 *         schema:
 *           type: integer
 *       - name: limit
 *         in: query
 *         description: Maximum number of messages to return
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 500
 *     responses:
 *       200:
 *         description: List of channel messages
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Message'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/channel/:channel', requirePermission('channels', 'read'), (req: Request, res: Response) => {
  try {
    const channel = parseInt(req.params.channel);
    const limitParam = req.query.limit;
    const limit = limitParam ? Math.min(parseInt(limitParam as string), 500) : 100;

    const dbMessages = databaseService.getMessagesByChannel(channel, limit);

    const messages = dbMessages.map(msg => ({
      id: msg.id,
      from: msg.fromNodeId,
      to: msg.toNodeId,
      text: msg.text,
      channel: msg.channel,
      timestamp: new Date(msg.rxTime ?? msg.timestamp),
      portnum: msg.portnum
    }));

    res.json(messages);
  } catch (error) {
    logger.error('Error fetching channel messages:', error);
    res.status(500).json({
      error: 'Failed to fetch channel messages',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * @openapi
 * /messages/direct/{nodeId1}/{nodeId2}:
 *   get:
 *     tags: [Messages]
 *     summary: Get direct messages between two nodes
 *     description: Returns direct messages exchanged between two specific nodes
 *     parameters:
 *       - name: nodeId1
 *         in: path
 *         required: true
 *         description: First node ID (hex format)
 *         schema:
 *           type: string
 *       - name: nodeId2
 *         in: path
 *         required: true
 *         description: Second node ID (hex format)
 *         schema:
 *           type: string
 *       - name: limit
 *         in: query
 *         description: Maximum number of messages to return
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 500
 *     responses:
 *       200:
 *         description: List of direct messages
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Message'
 *       401:
 *         $ref: '#/components/responses/UnauthorizedError'
 *       403:
 *         $ref: '#/components/responses/ForbiddenError'
 *       500:
 *         $ref: '#/components/responses/ServerError'
 */
router.get('/direct/:nodeId1/:nodeId2', requirePermission('messages', 'read'), (req: Request, res: Response) => {
  try {
    const { nodeId1, nodeId2 } = req.params;
    const limitParam = req.query.limit;
    const limit = limitParam ? Math.min(parseInt(limitParam as string), 500) : 100;

    const dbMessages = databaseService.getDirectMessages(nodeId1, nodeId2, limit);

    const messages = dbMessages.map(msg => ({
      id: msg.id,
      from: msg.fromNodeId,
      to: msg.toNodeId,
      text: msg.text,
      channel: msg.channel,
      timestamp: new Date(msg.rxTime ?? msg.timestamp),
      portnum: msg.portnum
    }));

    res.json(messages);
  } catch (error) {
    logger.error('Error fetching direct messages:', error);
    res.status(500).json({
      error: 'Failed to fetch direct messages',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
