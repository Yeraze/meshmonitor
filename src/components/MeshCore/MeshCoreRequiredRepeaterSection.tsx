/**
 * MeshCoreRequiredRepeaterSection (#6178 → #6193).
 *
 * Per-source picker naming the repeaters whose relay ends a channel send's
 * resend window, with an ANY / ALL mode:
 *   - ANY (default): the resend (↻) button goes away once ONE listed repeater
 *     is heard relaying the message.
 *   - ALL: the button stays until EVERY listed repeater is heard.
 *
 * Only DIRECT relays are offered — a relay (repeater / room-server) whose cached
 * route is zero-hop (`pathLen === 0`). A relay heard only via a flood / unknown
 * path is not offered. A key that was configured while direct but is no longer
 * (its `pathLen` changed, or its contact is gone) is KEPT and flagged, never
 * dropped silently.
 *
 * Stored per-source as `meshcoreRequiredRepeaters` (JSON array of full public
 * keys) + `meshcoreRequiredRepeaterMode`. Reads fall back to the legacy single
 * `meshcoreRequiredRepeater` via the shared `readRequiredRepeaters` reader, so
 * #6178 setups keep working with no migration; the first save through this UI
 * writes the new keys and clears the legacy one. No airtime impact — this only
 * changes when the (already rate-limited) resend is offered.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { parseJsonResponse } from '../../utils/parseJsonResponse';
import { useToast } from '../ToastContainer';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import {
  RELAY_ADV_TYPES,
  readRequiredRepeaters,
  type RequiredRepeaterMode,
} from '../../utils/meshcoreHeardBy';

export interface MeshCoreRequiredRepeaterSectionProps {
  baseUrl: string;
  sourceId: string;
  /** This source's known nodes/contacts; the picker lists the DIRECT relays. */
  contacts: MeshCoreContact[];
}

function repeaterLabel(c: MeshCoreContact): string {
  return c.advName || c.name || `${c.publicKey.slice(0, 12)}…`;
}

function shortKey(key: string): string {
  return `${key.slice(0, 12)}…`;
}

export const MeshCoreRequiredRepeaterSection: React.FC<MeshCoreRequiredRepeaterSectionProps> = ({
  baseUrl,
  sourceId,
  contacts,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const { showToast } = useToast();
  const sourceUrl = `${baseUrl}/api/settings?sourceId=${encodeURIComponent(sourceId)}`;
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<RequiredRepeaterMode>('any');
  const [saving, setSaving] = useState(false);

  // Direct relays only: a relay (repeater / room-server) with a zero-hop cached
  // route. `pathLen == null` (unknown / flood) and `pathLen > 0` are excluded.
  const directRelays = useMemo(() => {
    const byKey = new Map<string, MeshCoreContact>();
    for (const c of contacts) {
      if (!c.publicKey) continue;
      if (c.advType == null || !RELAY_ADV_TYPES.has(c.advType)) continue;
      if (c.pathLen !== 0) continue;
      if (!byKey.has(c.publicKey)) byKey.set(c.publicKey, c);
    }
    return [...byKey.values()].sort((a, b) => repeaterLabel(a).localeCompare(repeaterLabel(b)));
  }, [contacts]);

  // Contacts by key (any path), to name/flag a configured key that is no longer
  // direct rather than dropping it (keep-but-flag).
  const contactByKey = useMemo(() => {
    const m = new Map<string, MeshCoreContact>();
    for (const c of contacts) if (c.publicKey && !m.has(c.publicKey)) m.set(c.publicKey, c);
    return m;
  }, [contacts]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(sourceUrl);
        if (!res.ok) return;
        const settings = await parseJsonResponse(res);
        if (cancelled || !settings) return;
        const { keys, mode: readMode } = readRequiredRepeaters(settings);
        setSelected(keys);
        setMode(readMode);
      } catch {
        // Keep the default (none).
      }
    })();
    return () => { cancelled = true; };
  }, [csrfFetch, sourceUrl]);

  const persist = useCallback(async (nextKeys: string[], nextMode: RequiredRepeaterMode) => {
    const prevKeys = selected;
    const prevMode = mode;
    setSelected(nextKeys);
    setMode(nextMode);
    setSaving(true);
    const ok = await csrfFetch(sourceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meshcoreRequiredRepeaters: JSON.stringify(nextKeys),
        meshcoreRequiredRepeaterMode: nextMode,
        // Clear the legacy single key so an empty list never falls back to it.
        meshcoreRequiredRepeater: '',
      }),
    }).then(res => res.ok, () => false);
    setSaving(false);
    if (!ok) {
      setSelected(prevKeys);
      setMode(prevMode);
      showToast(t('meshcore.required_repeater.save_failed', 'Failed to save the required repeater'), 'error');
    }
  }, [selected, mode, csrfFetch, sourceUrl, showToast, t]);

  const toggleKey = useCallback((key: string) => {
    const next = selected.includes(key)
      ? selected.filter(k => k !== key)
      : [...selected, key];
    void persist(next, mode);
  }, [selected, mode, persist]);

  const changeMode = useCallback((next: RequiredRepeaterMode) => {
    if (next === mode) return;
    void persist(selected, next);
  }, [selected, mode, persist]);

  // Configured keys that are NOT in the direct-relay list: kept and flagged.
  const directKeys = useMemo(() => new Set(directRelays.map(r => r.publicKey)), [directRelays]);
  const flaggedKeys = useMemo(
    () => selected.filter(k => !directKeys.has(k)),
    [selected, directKeys],
  );

  return (
    <div className="form-section" data-testid="meshcore-required-repeater-settings">
      <h3>{t('meshcore.required_repeater.title', 'Required repeaters')}</h3>

      <label htmlFor="meshcore-required-repeater-mode">
        {t('meshcore.required_repeater.mode_label', 'Match mode')}
      </label>
      <select
        id="meshcore-required-repeater-mode"
        value={mode}
        disabled={saving}
        data-testid="meshcore-required-repeater-mode"
        aria-label={t('meshcore.required_repeater.mode_label', 'Match mode')}
        onChange={e => changeMode(e.target.value === 'all' ? 'all' : 'any')}
      >
        <option value="any">{t('meshcore.required_repeater.mode_any', 'Any — resend stops once one relays')}</option>
        <option value="all">{t('meshcore.required_repeater.mode_all', 'All — resend stops once every one relays')}</option>
      </select>

      <ul className="meshcore-required-repeater-list" data-testid="meshcore-required-repeater-list" style={{ listStyle: 'none', padding: 0 }}>
        {directRelays.map(r => (
          <li key={r.publicKey}>
            <label>
              <input
                type="checkbox"
                data-testid={`meshcore-required-repeater-option-${r.publicKey}`}
                checked={selected.includes(r.publicKey)}
                disabled={saving}
                onChange={() => toggleKey(r.publicKey)}
              />
              {' '}{repeaterLabel(r)}
            </label>
          </li>
        ))}
        {flaggedKeys.map(key => {
          const c = contactByKey.get(key);
          const label = c ? repeaterLabel(c) : shortKey(key);
          const flag = c
            ? t('meshcore.required_repeater.not_direct', 'no longer direct')
            : t('meshcore.required_repeater.saved_unknown', 'saved — not a known relay');
          return (
            <li key={key} data-testid={`meshcore-required-repeater-flagged-${key}`}>
              <label>
                <input
                  type="checkbox"
                  data-testid={`meshcore-required-repeater-option-${key}`}
                  checked
                  disabled={saving}
                  onChange={() => toggleKey(key)}
                />
                {' '}{label}{' '}
                <span className="hint" data-testid={`meshcore-required-repeater-flag-${key}`}>({flag})</span>
              </label>
            </li>
          );
        })}
        {directRelays.length === 0 && flaggedKeys.length === 0 && (
          <li className="hint" data-testid="meshcore-required-repeater-empty">
            {t(
              'meshcore.required_repeater.none_direct',
              'No direct repeaters yet. A relay must be heard with a zero-hop path to appear here.',
            )}
          </li>
        )}
      </ul>

      <p className="hint">
        {t(
          'meshcore.required_repeater.list_help',
          'Pick the direct repeaters this source should hear relay a channel message. Until the match mode is met, the message keeps its Resend button. Leave empty to resend as soon as any repeater relays it.',
        )}
      </p>
    </div>
  );
};

export default MeshCoreRequiredRepeaterSection;
