/**
 * MeshCore API Routes
 *
 * RESTful endpoints for MeshCore device interaction
 *
 * Authentication:
 * - Read-only endpoints use optionalAuth() (status, nodes, contacts, messages)
 * - Write operations require authentication (connect, disconnect, send, config)
 *
 * Thin barrel composing the 7 concern sub-routers (epic #3962 Task 4.3 —
 * mechanical split of the former ~3,900-line monolith). Mounting order
 * across sub-routers is behavior-neutral (every route's first path segment
 * belongs to exactly one group); the guard MUST run before every
 * sub-router so `res.locals.meshcoreManager` is set before any handler's
 * `managerFor()` call.
 */

import { Router } from 'express';
import { meshcoreRouteGuard } from './meshcoreRouteShared.js';
import deviceRoutes from './meshcoreDeviceRoutes.js';
import contactsRoutes from './meshcoreContactsRoutes.js';
import configRoutes from './meshcoreConfigRoutes.js';
import messagingRoutes from './meshcoreMessagingRoutes.js';
import adminRoutes from './meshcoreAdminRoutes.js';
import automationRoutes from './meshcoreAutomationRoutes.js';
import packetRoutes from './meshcorePacketRoutes.js';

const router = Router({ mergeParams: true });

router.use(meshcoreRouteGuard); // must run first — sets res.locals.meshcoreManager
router.use(deviceRoutes);
router.use(contactsRoutes);
router.use(configRoutes);
router.use(messagingRoutes);
router.use(adminRoutes);
router.use(automationRoutes);
router.use(packetRoutes);

export default router;
