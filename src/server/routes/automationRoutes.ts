/**
 * Automation Engine API (#3653, §6).
 *
 * Global `automations` permission (read for GET, write for mutations). Graph
 * configs are validated by validateAutomationGraph before persisting. CRUD
 * mutations reload the running engine so changes take effect immediately.
 */
import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import {
  validateAutomationGraph,
  ALL_NODE_TYPES,
  TRIGGER_TYPES,
  CONDITION_TYPES,
  ACTION_TYPES,
  FLOW_TYPES,
  VARIABLE_TYPES,
  VARIABLE_SCOPES,
  COLLAPSE_MODES,
  NUMERIC_OPS,
} from '../../types/automation.js';
import { reloadAutomations } from '../services/automation/automationEngineSingleton.js';
import { simulateAutomation, type SimEventInput } from '../services/automation/automationSimulator.js';
import { createMeshNodeDataProvider } from '../services/automation/meshNodeData.js';
import { unifyChannels, sourceProtocol } from '../services/automation/channelUnify.js';

const router = Router();

const canRead = requirePermission('automations', 'read');
const canWrite = requirePermission('automations', 'write');

/** Normalise a config (object or JSON string) → validated → JSON string. */
function validateConfig(raw: unknown): { ok: true; json: string } | { ok: false; errors: string[] } {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return { ok: false, errors: ['config is not valid JSON'] }; }
  }
  const result = validateAutomationGraph(parsed);
  if (!result.valid) return { ok: false, errors: result.errors };
  return { ok: true, json: JSON.stringify(result.graph) };
}

// ─── catalog (for the builder) ───────────────────────────────────────────────

router.get('/catalog', canRead, (_req: Request, res: Response) => {
  res.json({
    nodeTypes: ALL_NODE_TYPES,
    triggers: TRIGGER_TYPES,
    conditions: CONDITION_TYPES,
    actions: ACTION_TYPES,
    flow: FLOW_TYPES,
    collapseModes: COLLAPSE_MODES,
    numericOps: NUMERIC_OPS,
    variableTypes: VARIABLE_TYPES,
    variableScopes: VARIABLE_SCOPES,
  });
});

// ─── unified channels (for the Send-a-message picker) ────────────────────────

/**
 * Channels across all enabled, sendable (non-MQTT) sources, unified by name +
 * key fingerprint. The raw PSK is never returned — only a one-way fingerprint
 * the builder stores so the engine can resolve each source's local slot.
 */
router.get('/channels', canRead, async (_req: Request, res: Response) => {
  try {
    const sources = (await databaseService.sources.getAllSources())
      .filter((s) => s.enabled && !String(s.type).startsWith('mqtt'));
    const perSource = await Promise.all(sources.map(async (s) => ({
      sourceId: s.id,
      sourceName: s.name,
      protocol: sourceProtocol(s.type),
      channels: (await databaseService.channels.getAllChannels(s.id)).map((c) => ({ id: c.id, name: c.name, psk: c.psk, role: c.role })),
    })));
    res.json(unifyChannels(perSource));
  } catch (error) {
    logger.error('Error listing unified automation channels:', error);
    res.status(500).json({ error: 'Failed to list channels' });
  }
});

// ─── variables ───────────────────────────────────────────────────────────────

router.get('/variables', canRead, async (_req: Request, res: Response) => {
  try {
    res.json(await databaseService.automationVariables.listVariables());
  } catch (error) {
    logger.error('Error listing automation variables:', error);
    res.status(500).json({ error: 'Failed to list variables' });
  }
});

router.post('/variables', canWrite, async (req: Request, res: Response) => {
  try {
    const { name, description, type, scope, readonly, config } = req.body ?? {};
    if (!name || !type || !scope) {
      return res.status(400).json({ error: 'name, type and scope are required' });
    }
    if (!VARIABLE_TYPES.includes(type) || !VARIABLE_SCOPES.includes(scope)) {
      return res.status(400).json({ error: 'invalid type or scope' });
    }
    const created = await databaseService.automationVariables.createVariable({
      name, description, type, scope, readonly: !!readonly,
      config: typeof config === 'string' ? config : JSON.stringify(config ?? {}),
    });
    res.status(201).json(created);
  } catch (error: any) {
    // Unique-violation text differs per backend: SQLite "UNIQUE constraint failed",
    // PostgreSQL "duplicate key value violates unique constraint", MySQL "Duplicate entry".
    const emsg = String(error?.message).toLowerCase();
    if (emsg.includes('unique') || emsg.includes('duplicate')) {
      return res.status(409).json({ error: 'a variable with that name already exists' });
    }
    logger.error('Error creating automation variable:', error);
    res.status(500).json({ error: 'Failed to create variable' });
  }
});

router.put('/variables/:id', canWrite, async (req: Request, res: Response) => {
  try {
    const { config, ...rest } = req.body ?? {};
    const patch: Record<string, unknown> = { ...rest };
    if (config !== undefined) patch.config = typeof config === 'string' ? config : JSON.stringify(config);
    const updated = await databaseService.automationVariables.updateVariable(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'variable not found' });
    res.json(updated);
  } catch (error) {
    logger.error('Error updating automation variable:', error);
    res.status(500).json({ error: 'Failed to update variable' });
  }
});

router.delete('/variables/:id', canWrite, async (req: Request, res: Response) => {
  try {
    const ok = await databaseService.automationVariables.deleteVariable(req.params.id);
    if (!ok) return res.status(404).json({ error: 'variable not found' });
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting automation variable:', error);
    res.status(500).json({ error: 'Failed to delete variable' });
  }
});

// ─── test / dry-run (in-app "Test", also the system-test substrate) ──────────

/**
 * Dry-run a graph against a synthetic event and return the full trace. No mesh
 * IO, no Apprise dispatch, no variable persistence, no run-log row. Gated on
 * `automations:write` (same as editing). Used by the builder's Test panel.
 */
async function runSimulation(req: Request, res: Response, configRaw: unknown): Promise<Response | void> {
  const v = validateConfig(configRaw);
  if (!v.ok) return res.status(400).json({ error: 'invalid automation config', details: v.errors });
  const event = (req.body ?? {}).event;
  if (!event || typeof event !== 'object' || typeof event.kind !== 'string') {
    return res.status(400).json({ error: 'event.kind is required' });
  }
  if (!databaseService.automationVariablesRepo) {
    return res.status(503).json({ error: 'automation engine not ready' });
  }
  const { node, telemetry, variables } = req.body ?? {};
  const result = await simulateAutomation({
    graph: JSON.parse(v.json),
    event: event as SimEventInput,
    node, telemetry, variables,
    varsRepo: databaseService.automationVariablesRepo,
    liveData: createMeshNodeDataProvider(),
  });
  return res.json(result);
}

router.post('/test', canWrite, async (req: Request, res: Response) => {
  try {
    await runSimulation(req, res, (req.body ?? {}).config);
  } catch (error) {
    logger.error('Error simulating automation:', error);
    res.status(500).json({ error: 'Failed to simulate automation' });
  }
});

router.post('/:id/test', canWrite, async (req: Request, res: Response) => {
  try {
    const a = await databaseService.automations.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'automation not found' });
    await runSimulation(req, res, a.config);
  } catch (error) {
    logger.error('Error simulating automation:', error);
    res.status(500).json({ error: 'Failed to simulate automation' });
  }
});

// ─── automations ─────────────────────────────────────────────────────────────

router.get('/', canRead, async (_req: Request, res: Response) => {
  try {
    res.json(await databaseService.automations.listAutomations());
  } catch (error) {
    logger.error('Error listing automations:', error);
    res.status(500).json({ error: 'Failed to list automations' });
  }
});

router.get('/:id', canRead, async (req: Request, res: Response) => {
  try {
    const a = await databaseService.automations.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'automation not found' });
    res.json(a);
  } catch (error) {
    logger.error('Error fetching automation:', error);
    res.status(500).json({ error: 'Failed to fetch automation' });
  }
});

router.get('/:id/runs', canRead, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(await databaseService.automations.listRuns(req.params.id, limit));
  } catch (error) {
    logger.error('Error fetching automation runs:', error);
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

router.get('/:id/export', canRead, async (req: Request, res: Response) => {
  try {
    const a = await databaseService.automations.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'automation not found' });
    res.json({ name: a.name, description: a.description, config: JSON.parse(a.config) });
  } catch (error) {
    logger.error('Error exporting automation:', error);
    res.status(500).json({ error: 'Failed to export automation' });
  }
});

router.post('/', canWrite, async (req: Request, res: Response) => {
  try {
    const { name, description, enabled, config } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const v = validateConfig(config);
    if (!v.ok) return res.status(400).json({ error: 'invalid automation config', details: v.errors });
    const created = await databaseService.automations.createAutomation({
      name, description, enabled: !!enabled, config: v.json,
      createdByUserId: (req as any).user?.id ?? null,
    });
    await reloadAutomations();
    res.status(201).json(created);
  } catch (error) {
    logger.error('Error creating automation:', error);
    res.status(500).json({ error: 'Failed to create automation' });
  }
});

router.post('/import', canWrite, async (req: Request, res: Response) => {
  try {
    const { name, description, config } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const v = validateConfig(config);
    if (!v.ok) return res.status(400).json({ error: 'invalid automation config', details: v.errors });
    // Imported automations land DISABLED for review.
    const created = await databaseService.automations.createAutomation({
      name, description, enabled: false, config: v.json,
      createdByUserId: (req as any).user?.id ?? null,
    });
    res.status(201).json(created);
  } catch (error) {
    logger.error('Error importing automation:', error);
    res.status(500).json({ error: 'Failed to import automation' });
  }
});

router.put('/:id', canWrite, async (req: Request, res: Response) => {
  try {
    const { name, description, enabled, config } = req.body ?? {};
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (config !== undefined) {
      const v = validateConfig(config);
      if (!v.ok) return res.status(400).json({ error: 'invalid automation config', details: v.errors });
      patch.config = v.json;
    }
    const updated = await databaseService.automations.updateAutomation(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'automation not found' });
    await reloadAutomations();
    res.json(updated);
  } catch (error) {
    logger.error('Error updating automation:', error);
    res.status(500).json({ error: 'Failed to update automation' });
  }
});

router.post('/:id/enable', canWrite, async (req: Request, res: Response) => {
  try {
    await databaseService.automations.setEnabled(req.params.id, true);
    await reloadAutomations();
    res.json({ success: true });
  } catch (error) {
    logger.error('Error enabling automation:', error);
    res.status(500).json({ error: 'Failed to enable automation' });
  }
});

router.post('/:id/disable', canWrite, async (req: Request, res: Response) => {
  try {
    await databaseService.automations.setEnabled(req.params.id, false);
    await reloadAutomations();
    res.json({ success: true });
  } catch (error) {
    logger.error('Error disabling automation:', error);
    res.status(500).json({ error: 'Failed to disable automation' });
  }
});

router.delete('/:id', canWrite, async (req: Request, res: Response) => {
  try {
    const ok = await databaseService.automations.deleteAutomation(req.params.id);
    if (!ok) return res.status(404).json({ error: 'automation not found' });
    await reloadAutomations();
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting automation:', error);
    res.status(500).json({ error: 'Failed to delete automation' });
  }
});

export default router;
