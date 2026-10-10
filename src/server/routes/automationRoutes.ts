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
  forwardingToggleSourceIds,
  isStepOutputName,
} from '../../types/automation.js';
import { isForwardingEnabled } from '../services/forwardingStateService.js';
import { reloadAutomations, getAutomationEngine } from '../services/automation/automationEngineSingleton.js';
import { ok, fail } from '../utils/apiResponse.js';
import { simulateAutomation, type SimEventInput } from '../services/automation/automationSimulator.js';
import { createMeshNodeDataProvider } from '../services/automation/meshNodeData.js';
import { unifyChannels, sourceProtocol } from '../services/automation/channelUnify.js';
import { estimateHomeFromNodeHistory } from '../services/automation/leftHomeFromHistory.js';

const router = Router();

const canRead = requirePermission('automations', 'read');
const canWrite = requirePermission('automations', 'write');

/** Normalise a config (object or JSON string) → validated → JSON string. */
function validateConfig(raw: unknown): { ok: true; json: string; warnings: string[] } | { ok: false; errors: string[] } {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return { ok: false, errors: ['config is not valid JSON'] }; }
  }
  const result = validateAutomationGraph(parsed);
  if (!result.valid) return { ok: false, errors: result.errors };
  return { ok: true, json: JSON.stringify(result.graph), warnings: result.warnings ?? [] };
}

/**
 * action.setSourceForwardingEnabled (#5537) switches a source's forwarding
 * on or off, but automations are global and run as the system. So the gate is
 * here, at save: the saving user must hold `automation` write on every source
 * the graph targets (the same grant PUT /api/sources/:id/forwarding/enabled
 * needs). Admins pass. Sends a 403 and returns false when any is missing.
 */
async function checkForwardingTogglePermission(req: Request, res: Response, configJson: string): Promise<boolean> {
  let ids: string[];
  try { ids = forwardingToggleSourceIds(JSON.parse(configJson)); } catch { ids = []; }
  if (ids.length === 0) return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5537 matches the sibling handlers' (req as any).user; typed AuthenticatedRequest cleanup is out of scope
  const user = (req as any).user as { id: number; isAdmin?: boolean } | undefined;
  if (user?.isAdmin) return true;
  const denied: string[] = [];
  for (const id of ids) {
    const allowed = user ? await databaseService.checkPermissionAsync(user.id, 'automation', 'write', id) : false;
    if (!allowed) denied.push(id);
  }
  if (denied.length === 0) return true;
  fail(res, 403, 'FORWARDING_SOURCE_FORBIDDEN',
    'You need Automation write permission on every source this automation turns forwarding on or off',
    { sourceIds: denied });
  return false;
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

// ─── MeshCore regions (for the Send-a-message scope picker) ──────────────────

/**
 * Global saved-region catalog (#3833). The Automations UI is source-less, so it
 * uses the global catalog (regions are source-independent — a scope is just a
 * transport code derived from a name). Returns names only for the dropdown.
 */
router.get('/regions', canRead, async (_req: Request, res: Response) => {
  try {
    const regions = await databaseService.savedRegions.getAllAsync();
    res.json({ regions: regions.map((r) => ({ name: r.name })) });
  } catch (error) {
    logger.error('Error listing automation regions:', error);
    res.status(500).json({ error: 'Failed to list regions' });
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
    // Names must be dot-free identifiers so `{{ var.name.a.b }}` can split the
    // variable name from the nested JSON path unambiguously.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) {
      return res.status(400).json({ error: 'name must be a letters/digits/underscore identifier (no dots or spaces)' });
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
/**
 * The Test panel's sample script outputs (#5636): `{ <outputName>: <text> }`.
 * Keeps string values only and cuts each at the script runner's own 1 MiB
 * stdout cap, so a dry run cannot be fed more than a real script could print.
 */
function sampleStepOutputs(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  // Only well-formed run-output names are kept, and the object is built from
  // entries, so a request key such as `__proto__` never becomes a property write.
  const entries: Array<[string, string]> = [];
  for (const [name, text] of Object.entries(raw as Record<string, unknown>)) {
    if (isStepOutputName(name) && typeof text === 'string') entries.push([name, text.slice(0, 1024 * 1024)]);
  }
  return Object.fromEntries(entries);
}

async function runSimulation(req: Request, res: Response, configRaw: unknown, automationId?: string): Promise<Response | void> {
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
    // #5636: sample stdout per named "Run a script" step. Text only.
    stepOutputs: sampleStepOutputs((req.body ?? {}).stepOutputs),
    varsRepo: databaseService.automationVariablesRepo,
    liveData: createMeshNodeDataProvider(),
    automationId,
    // Read-only: lets a dry run of action.setAutomationEnabled report an unknown
    // id and the target's current state without changing it (#5445).
    lookupAutomation: (id) => databaseService.automations.getAutomation(id),
    // Read-only: the forwarding switch's current state for a dry run of
    // action.setSourceForwardingEnabled (#5537), without changing it.
    lookupSourceForwarding: async (sourceId) => {
      const source = await databaseService.sources.getSource(sourceId);
      if (!source) return null;
      return { id: source.id, name: source.name, enabled: await isForwardingEnabled(sourceId) };
    },
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
    await runSimulation(req, res, a.config, a.id);
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
    if (!(await checkForwardingTogglePermission(req, res, v.json))) return;
    const created = await databaseService.automations.createAutomation({
      name, description, enabled: !!enabled, config: v.json,
      createdByUserId: (req as any).user?.id ?? null,
    });
    await reloadAutomations();
    // #5697: non-blocking findings (an empty message, …) ride along so API and
    // import callers see what the builder shows.
    res.status(201).json(v.warnings.length > 0 ? { ...created, warnings: v.warnings } : created);
  } catch (error) {
    logger.error('Error creating automation:', error);
    res.status(500).json({ error: 'Failed to create automation' });
  }
});

router.post('/:id/duplicate', canWrite, async (req: Request, res: Response) => {
  try {
    const source = await databaseService.automations.getAutomation(req.params.id);
    if (!source) return fail(res, 404, 'AUTOMATION_NOT_FOUND', 'automation not found');
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (rawName.length > 200) {
      return fail(res, 400, 'INVALID_NAME', 'name must be 200 characters or fewer');
    }
    const name = rawName.length > 0 ? rawName : `${source.name} (copy)`;
    if (!(await checkForwardingTogglePermission(req, res, source.config))) return;
    // Duplicates land DISABLED so the user reviews before flipping them on
    // (mirrors the /import path). Uniqueness on `name` is not enforced by the
    // table, matching the plain POST / handler, so no collision check here.
    const created = await databaseService.automations.createAutomation({
      name,
      description: source.description,
      enabled: false,
      config: source.config,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5024 matches the sibling create/import handlers; a typed AuthenticatedRequest cleanup is out of scope for this PR
      createdByUserId: (req as any).user?.id ?? null,
    });
    // The clone is disabled, so the running engine has nothing to pick up, but
    // reload so a follow-up enable via the toggle sees the new row without a
    // separate refresh cycle.
    await reloadAutomations();
    res.status(201).json(created);
  } catch (error) {
    logger.error('Error duplicating automation:', error);
    return fail(res, 500, 'INTERNAL_ERROR', 'Failed to duplicate automation');
  }
});

router.post('/import', canWrite, async (req: Request, res: Response) => {
  try {
    const { name, description, config } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const v = validateConfig(config);
    if (!v.ok) return res.status(400).json({ error: 'invalid automation config', details: v.errors });
    if (!(await checkForwardingTogglePermission(req, res, v.json))) return;
    // Imported automations land DISABLED for review.
    const created = await databaseService.automations.createAutomation({
      name, description, enabled: false, config: v.json,
      createdByUserId: (req as any).user?.id ?? null,
    });
    res.status(201).json(v.warnings.length > 0 ? { ...created, warnings: v.warnings } : created);
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
    let warnings: string[] = [];
    if (config !== undefined) {
      const v = validateConfig(config);
      if (!v.ok) return res.status(400).json({ error: 'invalid automation config', details: v.errors });
      if (!(await checkForwardingTogglePermission(req, res, v.json))) return;
      patch.config = v.json;
      warnings = v.warnings;
    }
    const updated = await databaseService.automations.updateAutomation(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'automation not found' });
    await reloadAutomations();
    res.json(warnings.length > 0 ? { ...updated, warnings } : updated);
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

/**
 * Reset left-home anchors for a `trigger.leftHome` automation: delete stored
 * homes and re-seed each watched node from position-history inliers (median
 * cluster). Clears in-memory alarmed state so the rule can fire again.
 */
router.post('/:id/reset-homes', canWrite, async (req: Request, res: Response) => {
  try {
    const auto = await databaseService.automations.getAutomation(req.params.id);
    if (!auto) return res.status(404).json({ error: 'automation not found' });

    let graph: ReturnType<typeof validateAutomationGraph>['graph'];
    try {
      const parsed = JSON.parse(auto.config);
      const v = validateAutomationGraph(parsed);
      if (!v.valid || !v.graph) {
        return res.status(400).json({ error: 'invalid automation config', details: v.errors });
      }
      graph = v.graph;
    } catch {
      return res.status(400).json({ error: 'automation config is not valid JSON' });
    }

    const trigger = graph!.nodes.find((n) => n.type === 'trigger.leftHome');
    if (!trigger) {
      return res.status(400).json({ error: 'automation is not a left-home trigger' });
    }
    const params = (trigger.params ?? {}) as Record<string, unknown>;
    const nodeNums = Array.isArray(params.nodeNums)
      ? (params.nodeNums as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (nodeNums.length === 0) {
      return res.status(400).json({ error: 'no watched nodes configured' });
    }
    const thresholdMeters = Number(params.thresholdMeters ?? 300);
    const thr = Number.isFinite(thresholdMeters) && thresholdMeters > 0 ? thresholdMeters : 300;

    const repo = databaseService.automationHomeAnchorsRepo;
    if (!repo) return res.status(503).json({ error: 'home anchors store not available' });

    const results: Array<{
      nodeNum: number;
      seeded: boolean;
      latitude?: number;
      longitude?: number;
      sampleCount?: number;
      inlierCount?: number;
    }> = [];

    for (const nodeNum of nodeNums) {
      await repo.deleteAnchor(auto.id, nodeNum);
      const est = await estimateHomeFromNodeHistory(nodeNum, thr);
      if (est) {
        await repo.upsertAnchor(auto.id, nodeNum, est.latitude, est.longitude, Date.now());
        results.push({
          nodeNum,
          seeded: true,
          latitude: est.latitude,
          longitude: est.longitude,
          sampleCount: est.sampleCount,
          inlierCount: est.inlierCount,
        });
      } else {
        results.push({ nodeNum, seeded: false });
      }
    }

    getAutomationEngine()?.clearLeftHomeRuntimeState(auto.id);
    await reloadAutomations();

    res.json({
      success: true,
      thresholdMeters: thr,
      reset: nodeNums.length,
      seeded: results.filter((r) => r.seeded).length,
      results,
    });
  } catch (error) {
    logger.error('Error resetting left-home anchors:', error);
    res.status(500).json({ error: 'Failed to reset homes' });
  }
});

/**
 * Manually fire an automation's actions FOR REAL right now (#4827, "Run Now"),
 * bypassing its trigger schedule. Distinct from `/:id/test`, which is a safe
 * dry-run: this dispatches live actions (mesh sends, reboots, notifications).
 * Gated on `automations:write` — a real execution is at least as privileged as
 * editing the rule. Routes through the engine's real dispatch path, so the
 * per-automation cooldown, rate-limit and self-origin guards all still apply and
 * the cron cadence is left untouched.
 *
 * No extendRequestTimeout here: an automation's action list is unbounded, so
 * there is no sane worst-case to extend to. This route relies on the global
 * respondOnSocketTimeout() 504 safety net (requestTimeout.ts) instead — the
 * handler keeps running to completion even after the client gets its 504.
 */
router.post('/:id/run-now', canWrite, async (req: Request, res: Response) => {
  try {
    const engine = getAutomationEngine();
    if (!engine) return fail(res, 503, 'ENGINE_NOT_READY', 'automation engine not started');
    const result = await engine.runNow(req.params.id);
    if (result.reason === 'not_found') return fail(res, 404, 'AUTOMATION_NOT_FOUND', 'automation not found');
    if (result.reason === 'invalid') return fail(res, 400, 'INVALID_AUTOMATION', 'automation config is invalid');
    // cooldown / rate-limit suppression is a legitimate outcome (the guard did its
    // job) — return 200 with the verdict so the UI can explain why it did not fire.
    return ok(res, result);
  } catch (error) {
    logger.error('Error running automation now:', error);
    return fail(res, 500, 'RUN_NOW_FAILED', 'Failed to run automation');
  }
});

router.delete('/:id', canWrite, async (req: Request, res: Response) => {
  try {
    const ok = await databaseService.automations.deleteAutomation(req.params.id);
    if (!ok) return res.status(404).json({ error: 'automation not found' });
    // Drop any left-home anchors owned by this automation.
    try {
      await databaseService.automationHomeAnchorsRepo?.deleteByAutomation(req.params.id);
    } catch (e) {
      logger.warn(`Failed to clean home anchors for automation ${req.params.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await reloadAutomations();
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting automation:', error);
    res.status(500).json({ error: 'Failed to delete automation' });
  }
});

export default router;
