import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { useSaveBar } from '../../hooks/useSaveBar';

interface MeshCorePathfindingFilterSectionProps {
  baseUrl: string;
  sourceId: string;
  canWrite: boolean;
}

// Mirrors MeshcorePathfindingFilterSettings in src/services/database.ts (#4024).
interface PathfindingFilterSettings {
  enabled: boolean;
  targetKeys: string[];
  contactsEnabled: boolean;
  regexEnabled: boolean;
  nameRegex: string;
  lastHeardEnabled: boolean;
  lastHeardHours: number;
  hopsEnabled: boolean;
  hopsMin: number;
  hopsMax: number;
  signalEnabled: boolean;
  rssiMin: number;
  snrMin: number;
}

const FILTER_DEFAULTS: PathfindingFilterSettings = {
  enabled: false,
  targetKeys: [],
  contactsEnabled: false,
  regexEnabled: false,
  nameRegex: '.*',
  lastHeardEnabled: false,
  lastHeardHours: 168,
  hopsEnabled: false,
  hopsMin: 0,
  hopsMax: 10,
  signalEnabled: false,
  rssiMin: -200,
  snrMin: -100,
};

/**
 * Mirrors MC_PF_RSSI_FLOOR / MC_PF_SNR_FLOOR in src/server/meshcoreManager.ts
 * (a threshold at or below this sentinel is a no-op). Keep in sync — these
 * cannot be imported directly since this file ships to the browser bundle.
 */
const PF_RSSI_FLOOR = -200;
const PF_SNR_FLOOR = -100;

interface MeshCoreContactRow {
  publicKey: string;
  advName?: string;
  name?: string;
  lastSeen?: number;
  lastAdvert?: number;
  rssi?: number;
  snr?: number;
  advType?: number;
  pathLen?: number | null;
}

const contactDisplayName = (c: MeshCoreContactRow): string =>
  c.advName || c.name || c.publicKey.slice(0, 16);

const filterSettingsEqual = (a: PathfindingFilterSettings, b: PathfindingFilterSettings): boolean =>
  a.enabled === b.enabled &&
  a.contactsEnabled === b.contactsEnabled &&
  a.regexEnabled === b.regexEnabled &&
  a.nameRegex === b.nameRegex &&
  a.lastHeardEnabled === b.lastHeardEnabled &&
  a.lastHeardHours === b.lastHeardHours &&
  a.hopsEnabled === b.hopsEnabled &&
  a.hopsMin === b.hopsMin &&
  a.hopsMax === b.hopsMax &&
  a.signalEnabled === b.signalEnabled &&
  a.rssiMin === b.rssiMin &&
  a.snrMin === b.snrMin &&
  [...a.targetKeys].sort().join(',') === [...b.targetKeys].sort().join(',');

const parseFilterSettings = (d: Record<string, unknown>): PathfindingFilterSettings => ({
  enabled: typeof d.enabled === 'boolean' ? d.enabled : FILTER_DEFAULTS.enabled,
  targetKeys: Array.isArray(d.targetKeys) ? (d.targetKeys as string[]) : FILTER_DEFAULTS.targetKeys,
  contactsEnabled: typeof d.contactsEnabled === 'boolean' ? d.contactsEnabled : FILTER_DEFAULTS.contactsEnabled,
  regexEnabled: typeof d.regexEnabled === 'boolean' ? d.regexEnabled : FILTER_DEFAULTS.regexEnabled,
  nameRegex: typeof d.nameRegex === 'string' ? d.nameRegex : FILTER_DEFAULTS.nameRegex,
  lastHeardEnabled: typeof d.lastHeardEnabled === 'boolean' ? d.lastHeardEnabled : FILTER_DEFAULTS.lastHeardEnabled,
  lastHeardHours: typeof d.lastHeardHours === 'number' ? d.lastHeardHours : FILTER_DEFAULTS.lastHeardHours,
  hopsEnabled: typeof d.hopsEnabled === 'boolean' ? d.hopsEnabled : FILTER_DEFAULTS.hopsEnabled,
  hopsMin: typeof d.hopsMin === 'number' ? d.hopsMin : FILTER_DEFAULTS.hopsMin,
  hopsMax: typeof d.hopsMax === 'number' ? d.hopsMax : FILTER_DEFAULTS.hopsMax,
  signalEnabled: typeof d.signalEnabled === 'boolean' ? d.signalEnabled : FILTER_DEFAULTS.signalEnabled,
  rssiMin: typeof d.rssiMin === 'number' ? d.rssiMin : FILTER_DEFAULTS.rssiMin,
  snrMin: typeof d.snrMin === 'number' ? d.snrMin : FILTER_DEFAULTS.snrMin,
});

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.5rem',
};

const badgeStyle: React.CSSProperties = {
  background: 'var(--ctp-blue)',
  color: 'var(--ctp-base)',
  padding: '0.1rem 0.5rem',
  borderRadius: '10px',
  fontSize: '11px',
  fontWeight: 600,
};

const attributeBoxStyle: React.CSSProperties = {
  padding: '0.75rem 1rem',
  marginBottom: '0.75rem',
  background: 'var(--ctp-surface0)',
  border: '1px solid var(--ctp-surface1)',
  borderRadius: '6px',
};

/**
 * Auto-Pathfinding target filter panel (#4024). Lets the user narrow which
 * MeshCore contacts Auto-Pathfinding targets, via an OR-union of specific
 * contacts / name-regex, further narrowed by AND pre-filters (last-heard,
 * hop range, signal). See docs/internal/dev-notes/PATHFINDING_FILTER_SPEC.md §6.
 */
export const MeshCorePathfindingFilterSection: React.FC<MeshCorePathfindingFilterSectionProps> = ({
  baseUrl,
  sourceId,
  canWrite,
}) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();

  const [settings, setSettings] = useState<PathfindingFilterSettings>(FILTER_DEFAULTS);
  const [initial, setInitial] = useState<PathfindingFilterSettings>(FILTER_DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [contacts, setContacts] = useState<MeshCoreContactRow[]>([]);
  const [contactSearch, setContactSearch] = useState('');

  const fetchFilter = useCallback(async () => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/automation/pathfinding/filter`);
      if (!res.ok) return;
      const json = await res.json();
      if (json.success && json.data) {
        const s = parseFilterSettings(json.data);
        setSettings(s);
        setInitial(s);
        setLoaded(true);
      }
    } catch {
      // ignore fetch errors on load
    }
  }, [baseUrl, sourceId, csrfFetch]);

  const fetchContacts = useCallback(async () => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/contacts`);
      if (!res.ok) return;
      const json = await res.json();
      const rawData: unknown = json?.data;
      const rows: MeshCoreContactRow[] = Array.isArray(rawData)
        ? (rawData as Array<Record<string, unknown>>)
            .filter((c) => typeof c?.publicKey === 'string')
            .map((c) => ({
              publicKey: c.publicKey as string,
              advName: c.advName as string | undefined,
              name: c.name as string | undefined,
              lastSeen: c.lastSeen as number | undefined,
              lastAdvert: c.lastAdvert as number | undefined,
              rssi: c.rssi as number | undefined,
              snr: c.snr as number | undefined,
              advType: c.advType as number | undefined,
              pathLen: c.pathLen as number | null | undefined,
            }))
        : [];
      setContacts(rows);
    } catch {
      // ignore fetch errors on load
    }
  }, [baseUrl, sourceId, csrfFetch]);

  useEffect(() => { void fetchFilter(); }, [fetchFilter]);
  useEffect(() => { void fetchContacts(); }, [fetchContacts]);

  useEffect(() => {
    if (!loaded) return;
    setHasChanges(!filterSettingsEqual(settings, initial));
  }, [settings, initial, loaded]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const res = await csrfFetch(`${baseUrl}/api/sources/${sourceId}/meshcore/automation/pathfinding/filter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        if (res.status === 403) return;
        throw new Error(`Server returned ${res.status}`);
      }
      const json = await res.json();
      const persisted = json.success && json.data ? parseFilterSettings(json.data) : settings;
      setSettings(persisted);
      setInitial(persisted);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to save pathfinding filter settings:', error);
    } finally {
      setIsSaving(false);
    }
  }, [settings, baseUrl, sourceId, csrfFetch]);

  const handleDismiss = useCallback(() => {
    setSettings(initial);
    setHasChanges(false);
  }, [initial]);

  // No explicit `group` — inherits the ambient <SaveBarGroup id="meshcore-automation">
  // from MeshCorePage.tsx, the same group every other MeshCoreAutomationsView
  // section (Auto-Pathfinding, Auto-Ack, Auto-Announce, Auto-Responder, Timer
  // Triggers) already registers into. That group already renders N independently
  // dirty sections behind one "Save All" bar, so a 6th section here is the
  // established pattern, not a new one.
  useSaveBar({
    id: 'meshcore-pathfinding-filter',
    sectionName: t('meshcore.automation.pathfinding.filter.title', 'Target Filter'),
    hasChanges,
    isSaving,
    onSave: handleSave,
    onDismiss: handleDismiss,
  });

  const update = <K extends keyof PathfindingFilterSettings>(key: K, value: PathfindingFilterSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const filteredContacts = useMemo(() => {
    if (!contactSearch.trim()) return contacts;
    const q = contactSearch.toLowerCase().trim();
    return contacts.filter(c =>
      contactDisplayName(c).toLowerCase().includes(q) || c.publicKey.toLowerCase().includes(q)
    );
  }, [contacts, contactSearch]);

  const toggleContact = (publicKey: string) => {
    setSettings(prev => ({
      ...prev,
      targetKeys: prev.targetKeys.includes(publicKey)
        ? prev.targetKeys.filter(k => k !== publicKey)
        : [...prev.targetKeys, publicKey],
    }));
  };

  const handleSelectAll = () => {
    setSettings(prev => {
      const next = new Set([...prev.targetKeys, ...filteredContacts.map(c => c.publicKey)]);
      return { ...prev, targetKeys: Array.from(next) };
    });
  };

  const handleDeselectAll = () => {
    setSettings(prev => {
      const removing = new Set(filteredContacts.map(c => c.publicKey));
      return { ...prev, targetKeys: prev.targetKeys.filter(k => !removing.has(k)) };
    });
  };

  // Client-side sanity check only (server enforces RE2-safe compile via compileUserRegex).
  const regexError = useMemo(() => {
    if (!settings.nameRegex) return null;
    try {
      new RegExp(settings.nameRegex, 'i');
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [settings.nameRegex]);

  /**
   * Client-side reproduction of `filterPathfindingContacts`
   * (src/server/meshcoreManager.ts) for the live preview. MUST stay in
   * lockstep with the backend function — branch structure, AND-then-OR
   * order, and floor sentinels are copied verbatim. That backend function is
   * covered by `src/server/meshcoreManager.pathfindingFilter.test.ts` — any
   * change to its branch structure/semantics should update this preview (and
   * vice versa) in the same PR.
   *
   * CRITICAL unit note (verified against the manager's contact-write sites):
   * `lastSeen` is epoch **milliseconds**, `lastAdvert` is epoch **seconds**.
   * Both are normalized to a millisecond cutoff before comparison — using
   * the naive "both are seconds" assumption would make this preview
   * disagree with what the scheduler actually targets.
   */
  const matchingContacts = useMemo(() => {
    if (!settings.enabled) return contacts;

    let pool = contacts;
    if (settings.lastHeardEnabled) {
      const cutoffMs = Date.now() - settings.lastHeardHours * 3600 * 1000;
      pool = pool.filter(c => {
        const seenMs = c.lastSeen != null
          ? c.lastSeen
          : (c.lastAdvert != null ? c.lastAdvert * 1000 : null);
        return seenMs != null && seenMs >= cutoffMs;
      });
    }
    if (settings.hopsEnabled) {
      pool = pool.filter(c => {
        if (c.pathLen == null) return false; // unknown route excluded when hop filter on
        return c.pathLen >= settings.hopsMin && c.pathLen <= settings.hopsMax;
      });
    }
    if (settings.signalEnabled) {
      pool = pool.filter(c => {
        const passRssi = settings.rssiMin <= PF_RSSI_FLOOR || (c.rssi != null && c.rssi >= settings.rssiMin);
        const passSnr = settings.snrMin <= PF_SNR_FLOOR || (c.snr != null && c.snr >= settings.snrMin);
        return passRssi && passSnr;
      });
    }

    let regex: RegExp | null = null;
    if (settings.regexEnabled && settings.nameRegex && settings.nameRegex !== '.*') {
      try { regex = new RegExp(settings.nameRegex, 'i'); } catch { regex = null; }
    }
    const allow = new Set(settings.targetKeys);
    const hasAnyOr =
      (settings.contactsEnabled && allow.size > 0) ||
      (settings.regexEnabled && (regex !== null || settings.nameRegex === '.*'));
    if (!hasAnyOr) return pool; // AND-only ⇒ whole pool passes

    return pool.filter(c => {
      if (settings.contactsEnabled && allow.has(c.publicKey)) return true;
      if (settings.regexEnabled) {
        const name = c.advName || c.name || '';
        if (settings.nameRegex === '.*') return true;
        if (regex && regex.test(name)) return true;
      }
      return false;
    });
  }, [
    contacts,
    settings.enabled,
    settings.lastHeardEnabled,
    settings.lastHeardHours,
    settings.hopsEnabled,
    settings.hopsMin,
    settings.hopsMax,
    settings.signalEnabled,
    settings.rssiMin,
    settings.snrMin,
    settings.regexEnabled,
    settings.nameRegex,
    settings.contactsEnabled,
    settings.targetKeys,
  ]);

  // Debounced preview (1s), mirrors AutoTracerouteSection.tsx's matchingNodes pattern.
  const [debouncedMatching, setDebouncedMatching] = useState<MeshCoreContactRow[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedMatching(matchingContacts);
    }, 1000);
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [matchingContacts]);

  useEffect(() => {
    if (debouncedMatching.length === 0 && matchingContacts.length > 0) {
      setDebouncedMatching(matchingContacts);
    }
  }, [matchingContacts, debouncedMatching.length]);

  return (
    <div style={{ marginTop: '1.5rem', marginLeft: '1.75rem' }}>
      <div style={sectionHeaderStyle}>
        <input
          type="checkbox"
          id="pathfindingFilterEnabled"
          checked={settings.enabled}
          onChange={(e) => update('enabled', e.target.checked)}
          disabled={!canWrite}
          style={{ width: 'auto', margin: 0, cursor: canWrite ? 'pointer' : 'default' }}
        />
        <label htmlFor="pathfindingFilterEnabled" style={{ margin: 0, cursor: canWrite ? 'pointer' : 'default', fontWeight: 600 }}>
          {t('meshcore.automation.pathfinding.filter.master_toggle', 'Filter target contacts')}
        </label>
      </div>
      <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--ctp-subtext0)', lineHeight: '1.5' }}>
        {t(
          'meshcore.automation.pathfinding.filter.description',
          'Optionally narrow which contacts Auto-Pathfinding targets, instead of every Companion and Repeater contact.',
        )}
      </p>

      <div style={{
        opacity: settings.enabled ? 1 : 0.5,
        pointerEvents: settings.enabled ? 'auto' : 'none',
        transition: 'opacity 0.2s',
        display: 'flex',
        gap: '1rem',
        flexWrap: 'wrap',
      }}>
        {/* Left column: filter configuration */}
        <div style={{ flex: '1 1 360px', minWidth: 0 }}>

          {/* Specific contacts (OR) */}
          <div style={attributeBoxStyle}>
            <div style={sectionHeaderStyle}>
              <input
                type="checkbox"
                id="pfFilterContactsEnabled"
                checked={settings.contactsEnabled}
                onChange={(e) => update('contactsEnabled', e.target.checked)}
                disabled={!canWrite}
                style={{ width: 'auto', margin: 0 }}
              />
              <label htmlFor="pfFilterContactsEnabled" style={{ margin: 0, cursor: canWrite ? 'pointer' : 'default' }}>
                {t('meshcore.automation.pathfinding.filter.contacts_enable', 'Limit to selected contacts')}
              </label>
              {settings.targetKeys.length > 0 && (
                <span style={badgeStyle}>
                  {t('meshcore.automation.pathfinding.filter.count_badge', {
                    selected: settings.targetKeys.length,
                    total: contacts.length,
                    defaultValue: '{{selected}} / {{total}}',
                  })}
                </span>
              )}
            </div>
            <input
              type="text"
              placeholder={t('meshcore.automation.pathfinding.filter.search_placeholder', 'Search contacts…')}
              value={contactSearch}
              onChange={(e) => setContactSearch(e.target.value)}
              disabled={!canWrite}
              style={{
                width: '100%',
                padding: '0.4rem 0.5rem',
                marginBottom: '0.5rem',
                background: 'var(--ctp-surface1)',
                border: '1px solid var(--ctp-surface2)',
                borderRadius: '4px',
                color: 'var(--ctp-text)',
              }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <button
                type="button"
                onClick={handleSelectAll}
                disabled={!canWrite}
                className="btn-secondary"
                style={{ padding: '0.3rem 0.6rem', fontSize: '11px' }}
              >
                {t('meshcore.automation.pathfinding.filter.select_all', 'Select All')}
              </button>
              <button
                type="button"
                onClick={handleDeselectAll}
                disabled={!canWrite}
                className="btn-secondary"
                style={{ padding: '0.3rem 0.6rem', fontSize: '11px' }}
              >
                {t('meshcore.automation.pathfinding.filter.deselect_all', 'Deselect All')}
              </button>
            </div>
            <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--ctp-surface2)', borderRadius: '4px' }}>
              {filteredContacts.length === 0 ? (
                <div style={{ padding: '0.5rem', textAlign: 'center', color: 'var(--ctp-subtext0)', fontSize: '12px' }}>
                  {t('meshcore.automation.pathfinding.filter.no_contacts', 'No contacts found')}
                </div>
              ) : (
                filteredContacts.map(c => (
                  <div
                    key={c.publicKey}
                    onClick={() => canWrite && toggleContact(c.publicKey)}
                    style={{
                      padding: '0.4rem 0.6rem',
                      borderBottom: '1px solid var(--ctp-surface1)',
                      display: 'flex',
                      alignItems: 'center',
                      cursor: canWrite ? 'pointer' : 'default',
                      fontSize: '12px',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={settings.targetKeys.includes(c.publicKey)}
                      onChange={() => toggleContact(c.publicKey)}
                      onClick={(e) => e.stopPropagation()}
                      disabled={!canWrite}
                      style={{ width: 'auto', margin: 0, marginRight: '0.5rem' }}
                    />
                    <span style={{ color: 'var(--ctp-text)' }}>{contactDisplayName(c)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Name regex (OR) */}
          <div style={attributeBoxStyle}>
            <div style={sectionHeaderStyle}>
              <input
                type="checkbox"
                id="pfFilterRegexEnabled"
                checked={settings.regexEnabled}
                onChange={(e) => update('regexEnabled', e.target.checked)}
                disabled={!canWrite}
                style={{ width: 'auto', margin: 0 }}
              />
              <label htmlFor="pfFilterRegexEnabled" style={{ margin: 0, cursor: canWrite ? 'pointer' : 'default' }}>
                {t('meshcore.automation.pathfinding.filter.regex_enable', 'Filter by name (regex)')}
              </label>
            </div>
            <label htmlFor="pfFilterNameRegex" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem' }}>
              {t('meshcore.automation.pathfinding.filter.regex_label', 'Name regex')}
            </label>
            <input
              id="pfFilterNameRegex"
              type="text"
              value={settings.nameRegex}
              onChange={(e) => update('nameRegex', e.target.value)}
              disabled={!canWrite}
              className="setting-input"
              style={{ width: '100%' }}
            />
            {regexError && (
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--ctp-red)' }}>
                {t('meshcore.automation.pathfinding.filter.regex_invalid', 'Invalid regular expression')}: {regexError}
              </p>
            )}
          </div>

          {/* Last heard (AND) */}
          <div style={attributeBoxStyle}>
            <div style={sectionHeaderStyle}>
              <input
                type="checkbox"
                id="pfFilterLastHeardEnabled"
                checked={settings.lastHeardEnabled}
                onChange={(e) => update('lastHeardEnabled', e.target.checked)}
                disabled={!canWrite}
                style={{ width: 'auto', margin: 0 }}
              />
              <label htmlFor="pfFilterLastHeardEnabled" style={{ margin: 0, cursor: canWrite ? 'pointer' : 'default' }}>
                {t('meshcore.automation.pathfinding.filter.last_heard_enable', 'Limit by last heard')}
              </label>
            </div>
            <label htmlFor="pfFilterLastHeardHours" style={{ display: 'block', fontSize: '0.8rem', color: 'var(--ctp-subtext0)', marginBottom: '0.25rem' }}>
              {t('meshcore.automation.pathfinding.filter.last_heard_label', 'Heard within (hours)')}
            </label>
            <input
              id="pfFilterLastHeardHours"
              type="number"
              min={1}
              max={8760}
              value={settings.lastHeardHours}
              onChange={(e) => update('lastHeardHours', Math.min(8760, Math.max(1, parseInt(e.target.value, 10) || 1)))}
              disabled={!canWrite}
              className="setting-input"
              style={{ width: '120px' }}
            />
          </div>

          {/* Hop range (AND) */}
          <div style={attributeBoxStyle}>
            <div style={sectionHeaderStyle}>
              <input
                type="checkbox"
                id="pfFilterHopsEnabled"
                checked={settings.hopsEnabled}
                onChange={(e) => update('hopsEnabled', e.target.checked)}
                disabled={!canWrite}
                style={{ width: 'auto', margin: 0 }}
              />
              <label htmlFor="pfFilterHopsEnabled" style={{ margin: 0, cursor: canWrite ? 'pointer' : 'default' }}>
                {t('meshcore.automation.pathfinding.filter.hops_enable', 'Limit by hop range')}
              </label>
            </div>
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.35rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--ctp-subtext0)' }}>
                {t('meshcore.automation.pathfinding.filter.hops_min_label', 'Min hops')}
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={settings.hopsMin}
                  onChange={(e) => {
                    const v = Math.min(10, Math.max(0, parseInt(e.target.value, 10) || 0));
                    update('hopsMin', v);
                    if (v > settings.hopsMax) update('hopsMax', v);
                  }}
                  disabled={!canWrite}
                  className="setting-input"
                  style={{ width: '80px', display: 'block', marginTop: '0.25rem' }}
                />
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--ctp-subtext0)' }}>
                {t('meshcore.automation.pathfinding.filter.hops_max_label', 'Max hops')}
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={settings.hopsMax}
                  onChange={(e) => {
                    const v = Math.min(10, Math.max(0, parseInt(e.target.value, 10) || 0));
                    update('hopsMax', Math.max(v, settings.hopsMin));
                  }}
                  disabled={!canWrite}
                  className="setting-input"
                  style={{ width: '80px', display: 'block', marginTop: '0.25rem' }}
                />
              </label>
            </div>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
              {t('meshcore.automation.pathfinding.filter.hops_unknown_note',
                'Contacts with an unknown route (flood) are excluded when this is on.')}
            </p>
          </div>

          {/* Signal (AND) */}
          <div style={attributeBoxStyle}>
            <div style={sectionHeaderStyle}>
              <input
                type="checkbox"
                id="pfFilterSignalEnabled"
                checked={settings.signalEnabled}
                onChange={(e) => update('signalEnabled', e.target.checked)}
                disabled={!canWrite}
                style={{ width: 'auto', margin: 0 }}
              />
              <label htmlFor="pfFilterSignalEnabled" style={{ margin: 0, cursor: canWrite ? 'pointer' : 'default' }}>
                {t('meshcore.automation.pathfinding.filter.signal_enable', 'Limit by signal quality')}
              </label>
            </div>
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.35rem' }}>
              <label style={{ fontSize: '0.8rem', color: 'var(--ctp-subtext0)' }}>
                {t('meshcore.automation.pathfinding.filter.rssi_min_label', 'Min RSSI (dBm)')}
                <input
                  type="number"
                  min={-200}
                  max={0}
                  value={settings.rssiMin}
                  onChange={(e) => update('rssiMin', Math.min(0, Math.max(-200, parseInt(e.target.value, 10) || -200)))}
                  disabled={!canWrite}
                  className="setting-input"
                  style={{ width: '90px', display: 'block', marginTop: '0.25rem' }}
                />
              </label>
              <label style={{ fontSize: '0.8rem', color: 'var(--ctp-subtext0)' }}>
                {t('meshcore.automation.pathfinding.filter.snr_min_label', 'Min SNR (dB)')}
                <input
                  type="number"
                  min={-100}
                  max={100}
                  value={settings.snrMin}
                  onChange={(e) => update('snrMin', Math.min(100, Math.max(-100, parseInt(e.target.value, 10) || -100)))}
                  disabled={!canWrite}
                  className="setting-input"
                  style={{ width: '90px', display: 'block', marginTop: '0.25rem' }}
                />
              </label>
            </div>
            <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--ctp-subtext0)' }}>
              {t('meshcore.automation.pathfinding.filter.signal_note', 'Leave a threshold at its floor value to ignore it.')}
            </p>
          </div>
        </div>

        {/* Right column: live matching-targets preview */}
        <div style={{
          width: '280px',
          flexShrink: 0,
          background: 'var(--ctp-base)',
          border: '1px solid var(--ctp-surface2)',
          borderRadius: '6px',
          display: 'flex',
          flexDirection: 'column',
          alignSelf: 'flex-start',
        }}>
          <div style={{
            padding: '0.5rem 0.75rem',
            borderBottom: '1px solid var(--ctp-surface2)',
            background: 'var(--ctp-surface1)',
            borderRadius: '6px 6px 0 0',
            fontSize: '13px',
            fontWeight: 500,
          }}>
            {t('meshcore.automation.pathfinding.filter.preview_count', {
              count: debouncedMatching.length,
              defaultValue: '{{count}} contacts will be targeted',
            })} / {contacts.length} {t('common.total', 'total')}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', maxHeight: '400px', padding: '0.25rem' }}>
            {debouncedMatching.length === 0 ? (
              <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--ctp-subtext0)', fontSize: '12px' }}>
                {t('meshcore.automation.pathfinding.filter.no_match', 'No contacts match the current filters')}
              </div>
            ) : (
              debouncedMatching.map(c => (
                <div
                  key={c.publicKey}
                  title={contactDisplayName(c)}
                  style={{
                    padding: '0.35rem 0.5rem',
                    borderBottom: '1px solid var(--ctp-surface1)',
                    fontSize: '12px',
                    color: 'var(--ctp-text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {contactDisplayName(c)}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
