/**
 * MeshCoreRequiredRepeaterSection (#6178).
 *
 * Per-source picker naming ONE repeater whose relay ends a channel send's
 * resend window. Default "None (default)" keeps today's behavior: the resend
 * (↻) button goes away as soon as ANY repeater is heard. When a repeater is
 * chosen, the button stays until THAT repeater is heard relaying the message.
 *
 * The value stored is the repeater's full public key (hex). Reads/writes the
 * per-source `meshcoreRequiredRepeater` setting via `/api/settings?sourceId=`,
 * exactly like MeshCoreReactionsSection. No airtime impact — this only changes
 * when the (already rate-limited) resend is offered.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { parseJsonResponse } from '../../utils/parseJsonResponse';
import { useToast } from '../ToastContainer';
import { MeshCoreContact } from '../../utils/meshcoreHelpers';
import { RELAY_ADV_TYPES } from '../../utils/meshcoreHeardBy';

export interface MeshCoreRequiredRepeaterSectionProps {
  baseUrl: string;
  sourceId: string;
  /** This source's known nodes/contacts; the picker lists the relays among them. */
  contacts: MeshCoreContact[];
}

function repeaterLabel(c: MeshCoreContact): string {
  return c.advName || c.name || `${c.publicKey.slice(0, 12)}…`;
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
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Relays only (repeater / room-server), de-duplicated by public key, sorted
  // by display name for a stable list.
  const repeaters = useMemo(() => {
    const byKey = new Map<string, MeshCoreContact>();
    for (const c of contacts) {
      if (!c.publicKey) continue;
      if (c.advType != null && !RELAY_ADV_TYPES.has(c.advType)) continue;
      if (c.advType == null) continue; // unknown type: not offered as a pickable relay
      if (!byKey.has(c.publicKey)) byKey.set(c.publicKey, c);
    }
    return [...byKey.values()].sort((a, b) => repeaterLabel(a).localeCompare(repeaterLabel(b)));
  }, [contacts]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await csrfFetch(sourceUrl);
        if (!res.ok) return;
        const settings = await parseJsonResponse(res);
        if (cancelled || !settings) return;
        const raw = settings.meshcoreRequiredRepeater;
        setValue(typeof raw === 'string' ? raw : '');
      } catch {
        // Keep the default (none).
      }
    })();
    return () => { cancelled = true; };
  }, [csrfFetch, sourceUrl]);

  const save = useCallback(async (next: string) => {
    const prev = value;
    setValue(next);
    setSaving(true);
    const ok = await csrfFetch(sourceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meshcoreRequiredRepeater: next }),
    }).then(res => res.ok, () => false);
    setSaving(false);
    if (!ok) {
      setValue(prev);
      showToast(t('meshcore.required_repeater.save_failed', 'Failed to save the required repeater'), 'error');
    }
  }, [value, csrfFetch, sourceUrl, showToast, t]);

  // If the stored repeater is not (or no longer) a known relay, keep it as an
  // extra option so the selection is not silently lost.
  const hasStored = value !== '' && !repeaters.some(r => r.publicKey === value);

  return (
    <div className="form-section" data-testid="meshcore-required-repeater-settings">
      <h3>{t('meshcore.required_repeater.title', 'Required repeater')}</h3>
      <select
        value={value}
        disabled={saving}
        data-testid="meshcore-required-repeater-select"
        aria-label={t('meshcore.required_repeater.title', 'Required repeater')}
        onChange={e => void save(e.target.value)}
      >
        <option value="">{t('meshcore.required_repeater.none', 'None (default)')}</option>
        {repeaters.map(r => (
          <option key={r.publicKey} value={r.publicKey}>{repeaterLabel(r)}</option>
        ))}
        {hasStored && (
          <option value={value}>{t('meshcore.required_repeater.unknown', 'Saved repeater ({{key}})', { key: `${value.slice(0, 12)}…` })}</option>
        )}
      </select>
      <p className="hint">
        {t(
          'meshcore.required_repeater.help',
          'When set, a channel message keeps its Resend button until THIS repeater is heard relaying it, not just any repeater. Leave on "None" to resend as soon as any repeater relays it.',
        )}
      </p>
    </div>
  );
};

export default MeshCoreRequiredRepeaterSection;
