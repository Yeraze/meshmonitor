/**
 * Auto-Acknowledge → Automation converter API (#4340 Phase 4, WP3).
 *
 * Two POST endpoints: `/preview` (writes nothing) and `/create`. Both re-run
 * the conversion server-side from the source's CURRENT settings via
 * `convertAutoAckForSource()` — neither trusts a client-supplied graph
 * (spec §5.3). See docs/internal/dev-notes/AUTOACK_CONVERTER_PHASE4_SPEC.md §5.
 *
 * Mounted in server.ts immediately before the existing `/automations` mount
 * so `/:id` there cannot swallow `/automations/convert/*`.
 */
import { Router, Request, Response } from 'express';
import { requirePermission } from '../auth/authMiddleware.js';
import { ok, fail } from '../utils/apiResponse.js';
import databaseService from '../../services/database.js';
import { validateAutomationGraph } from '../../types/automation.js';
import type { FormBlock, Rule } from '../../components/automations/compile.js';
import { reloadAutomations } from '../services/automation/automationEngineSingleton.js';
import {
  convertAutoAckForSource,
  findExistingConversions,
  type AutoAckConversionContext,
} from '../services/automation/autoAckConverterService.js';
import type { ConvertedAutomation } from '../services/automation/autoAckConverter.js';

const router = Router();

// ─── §5.1: permissions ──────────────────────────────────────────────────────
// `automations` is a global resource; `automation` is per-source
// (src/types/permission.ts). Both are checked, chained, on both routes.

const canPreview = [
  requirePermission('automations', 'read'),
  requirePermission('automation', 'read', { sourceIdFrom: 'body', requireSourceId: true }),
];
const canCreate = [
  requirePermission('automations', 'write'),
  requirePermission('automation', 'write', { sourceIdFrom: 'body', requireSourceId: true }),
];

// ─── shared helpers ─────────────────────────────────────────────────────────

/** One readable English line per rule, for the preview UI (spec §5.2's `ruleSummaries`). */
function summarizeBlock(b: FormBlock): string {
  switch (b.type) {
    case 'condition.sourceFilter':
      return 'message is from this source';
    case 'condition.string':
    case 'condition.numeric':
      return `${b.params.field} ${b.params.op} ${JSON.stringify(b.params.value)}`;
    case 'action.delay':
      return `wait ${b.params.seconds}s`;
    case 'action.tapback':
      return 'react with a hop-count tapback';
    case 'action.sendMessage':
      return b.params.to ? 'send a DM reply' : 'send a reply';
    default:
      return b.type;
  }
}

function summarizeRule(rule: Rule): string {
  const conditions = rule.conditions.map(summarizeBlock).join(' AND ');
  const actions = rule.actions.map(summarizeBlock).join('; ');
  return `If ${conditions || 'always'}: ${actions || 'do nothing'}.`;
}

function automationForResponse(a: ConvertedAutomation) {
  return {
    key: a.key,
    name: a.name,
    description: a.description,
    enabled: a.enabled,
    config: a.config,
    form: a.form,
    ruleSummaries: a.form.rules.map(summarizeRule),
  };
}

/** Validates every produced graph; returns the failures (empty when all valid). */
function invalidAutomations(context: AutoAckConversionContext): Array<{ key: string; errors: string[] }> {
  const failures: Array<{ key: string; errors: string[] }> = [];
  for (const a of context.automations) {
    const result = validateAutomationGraph(a.config);
    if (!result.valid) failures.push({ key: a.key, errors: result.errors });
  }
  return failures;
}

/** Shared source resolution + error mapping for both routes. */
async function resolveContext(
  res: Response,
  sourceId: string,
): Promise<AutoAckConversionContext | null> {
  const result = await convertAutoAckForSource(sourceId);
  if (!result.ok) {
    if (result.code === 'SOURCE_NOT_FOUND') {
      fail(res, 404, 'SOURCE_NOT_FOUND', `No source found with id "${sourceId}".`);
      return null;
    }
    fail(
      res,
      400,
      'SOURCE_NOT_MESHTASTIC',
      'Auto-Acknowledge conversion is only supported for Meshtastic sources.',
    );
    return null;
  }
  return result.context;
}

// ─── POST /preview — writes nothing ────────────────────────────────────────

router.post('/preview', ...canPreview, async (req: Request, res: Response) => {
  try {
    const sourceId = String(req.body?.sourceId);
    const context = await resolveContext(res, sourceId);
    if (!context) return; // resolveContext already sent the error response

    const invalid = invalidAutomations(context);
    if (invalid.length > 0) {
      fail(
        res,
        500,
        'CONVERTER_PRODUCED_INVALID_GRAPH',
        'The converter produced an invalid automation graph — this is a converter bug, not a settings problem.',
        { details: invalid },
      );
      return;
    }

    const existing = await findExistingConversions(sourceId);

    ok(res, {
      sourceId,
      sourceName: context.source.name,
      autoAckEnabled: context.autoAckEnabled,
      automations: context.automations.map(automationForResponse),
      report: context.report,
      existing,
      blocking: context.blocking ?? null,
    });
  } catch (error) {
    fail(res, 500, 'AUTOACK_CONVERT_PREVIEW_FAILED', error instanceof Error ? error.message : 'Failed to preview the Auto-Acknowledge conversion.');
  }
});

// ─── POST /create ───────────────────────────────────────────────────────────

router.post('/create', ...canCreate, async (req: Request, res: Response) => {
  try {
    const sourceId = String(req.body?.sourceId);
    const enable = req.body?.enable !== false;
    const disableAutoAck = req.body?.disableAutoAck !== false;
    const replaceExisting = req.body?.replaceExisting === true;

    // §5.1 / §5.3 step 3: the settings:write gate for `disableAutoAck` is
    // checked HERE — before any of steps 1/2's reads have side effects and,
    // critically, before step 4's writes below — so a caller lacking
    // settings:write is refused the WHOLE operation. Half-applying (creating
    // the automation(s) but silently skipping the disable, or vice versa)
    // would leave the source in a state the caller never asked for.
    if (disableAutoAck) {
      const canWriteSettings = await databaseService.checkPermissionAsync(
        req.user!.id,
        'settings',
        'write',
      );
      if (!canWriteSettings) {
        fail(
          res,
          403,
          'SETTINGS_WRITE_REQUIRED',
          'Turning off Auto-Acknowledge requires settings write permission — nothing was created.',
        );
        return;
      }
    }

    // Step 1: re-run the conversion server-side from CURRENT settings and validate.
    const context = await resolveContext(res, sourceId);
    if (!context) return;

    const invalid = invalidAutomations(context);
    if (invalid.length > 0) {
      fail(res, 400, 'INVALID_AUTOMATION_CONFIG', 'The converter produced an invalid automation graph.', {
        details: invalid,
      });
      return;
    }

    // A `blocking` reason (spec §4.2/§4.3) means the UI would have the Convert
    // button disabled; re-check it here since create never trusts the client.
    // Refuse the whole operation rather than silently creating a partial
    // result (e.g. only the Direct automation when the Channel one is blocked).
    if (context.blocking) {
      fail(
        res,
        400,
        context.blocking,
        context.blocking === 'NO_CELLS_ENABLED'
          ? 'Nothing to convert — no Auto-Acknowledge cell is enabled for this source.'
          : "The channel allowlist could not be converted — see the report for which entries failed.",
        { report: context.report },
      );
      return;
    }

    // Step 2: existing-marker check → 409 unless replaceExisting.
    const existing = await findExistingConversions(sourceId);
    if (existing.length > 0 && !replaceExisting) {
      fail(
        res,
        409,
        'AUTOACK_ALREADY_CONVERTED',
        'This source already has automation(s) converted from Auto-Acknowledge. Pass replaceExisting: true to replace them.',
        { existing },
      );
      return;
    }

    // Step 4: create / update / delete, matched by the `(channel|direct)` key
    // parsed from each existing automation's description (§4.7).
    const existingByKind = new Map(
      existing.filter((e) => e.kind !== null).map((e) => [e.kind as 'channel' | 'direct', e]),
    );
    const neededKinds = new Set(context.automations.map((a) => a.key));

    const created: Awaited<ReturnType<typeof databaseService.automations.createAutomation>>[] = [];
    const updated: Awaited<ReturnType<typeof databaseService.automations.createAutomation>>[] = [];
    const deleted: string[] = [];

    for (const automation of context.automations) {
      const match = existingByKind.get(automation.key);
      const configJson = JSON.stringify(automation.config);
      if (match && replaceExisting) {
        const rec = await databaseService.automations.updateAutomation(match.id, {
          name: automation.name,
          description: automation.description,
          enabled: enable,
          config: configJson,
        });
        if (rec) updated.push(rec);
      } else {
        const rec = await databaseService.automations.createAutomation({
          name: automation.name,
          description: automation.description,
          enabled: enable,
          config: configJson,
          createdByUserId: req.user?.id ?? null,
        });
        created.push(rec);
      }
    }
    if (replaceExisting) {
      for (const e of existing) {
        if (e.kind !== null && !neededKinds.has(e.kind)) {
          const removed = await databaseService.automations.deleteAutomation(e.id);
          if (removed) deleted.push(e.id);
        }
      }
    }

    // Step 5: disable Auto-Acknowledge — deliberately AFTER step 4's writes
    // above, not before. If the process crashes between them, the failure
    // mode is "both mechanisms armed" (AutoAck still on AND the new
    // automation now also answering — a visible, fixable double-ack) rather
    // than "neither armed" (AutoAck off, automation write lost — a silent
    // loss of a range-test responder nobody would notice until it mattered).
    // Only `autoAckEnabled` is ever touched; every other Auto-Acknowledge
    // setting is left intact so the user can switch back and get their old
    // config back exactly (spec §5.3 step 5).
    let autoAckDisabled = false;
    if (disableAutoAck) {
      await databaseService.settings.setSourceSetting(sourceId, 'autoAckEnabled', 'false');
      autoAckDisabled = true;
    }

    // Step 6.
    await reloadAutomations();

    // Step 7.
    ok(res, { created, updated, deleted, autoAckDisabled, report: context.report });
  } catch (error) {
    fail(res, 500, 'AUTOACK_CONVERT_CREATE_FAILED', error instanceof Error ? error.message : 'Failed to create the Auto-Acknowledge conversion.');
  }
});

export default router;
