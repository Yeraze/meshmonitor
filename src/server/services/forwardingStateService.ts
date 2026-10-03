/**
 * Message Forwarding master switch (#5537) — one per-source on/off that gates
 * every forwarding rule on that source.
 *
 * Stored as the per-source `forwardingEnabled` setting ('true' / 'false'),
 * absent = ON, so an install that predates the switch keeps forwarding. The
 * Meshtastic and MeshCore managers read it on every incoming message, so a
 * change takes effect on the next packet with no restart.
 *
 * Flipping the switch never touches the forwarding rate limiter (it lives at
 * module scope in forwardingEngine.ts), so turning forwarding off and back on
 * cannot re-open a spent 5-per-minute window. It also sends nothing.
 */
import databaseService from '../../services/database.js';
import {
  FORWARDING_ENABLED_SETTING_KEY,
  FORWARDING_SETTING_KEY,
  parseForwardingEnabled,
} from '../../types/forwarding.js';
import { parseStoredForwardingRules } from '../utils/forwardingEngine.js';

export async function isForwardingEnabled(sourceId: string): Promise<boolean> {
  const raw = await databaseService.settings.getSettingForSource(sourceId, FORWARDING_ENABLED_SETTING_KEY);
  return parseForwardingEnabled(raw);
}

export async function setForwardingEnabled(sourceId: string, enabled: boolean): Promise<void> {
  await databaseService.settings.setSourceSetting(sourceId, FORWARDING_ENABLED_SETTING_KEY, enabled ? 'true' : 'false');
}

export interface ForwardingSummary {
  enabled: boolean;
  /** Every stored rule, on or off. */
  ruleCount: number;
  /** Rules whose own `enabled` flag is on. */
  activeRuleCount: number;
}

export async function getForwardingSummary(sourceId: string): Promise<ForwardingSummary> {
  const raw = await databaseService.settings.getSettingForSource(sourceId, FORWARDING_SETTING_KEY);
  const enabled = await isForwardingEnabled(sourceId);
  const rules = parseStoredForwardingRules(raw);
  return { enabled, ruleCount: rules.length, activeRuleCount: rules.filter(r => r.enabled).length };
}
