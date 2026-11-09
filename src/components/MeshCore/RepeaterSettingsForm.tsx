import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigSection } from '../shared/config/ConfigSection';
import { PasswordField } from '../shared/config/PasswordField';
import { NumberInput } from '../common/NumberInput';
import { NumberInputScope } from '../common/NumberInputScope';
import { useNumberInputScope } from '../common/numberInputScopeContext';
import { UiIcon } from '../icons';
import { MESHCORE_DOCS } from './meshcoreDocs';
import type {
  RemoteSettingsGroup,
  RepeaterSaveResponse,
  RepeaterSettingsPatch,
  RepeaterSettingsValues,
} from './hooks/useMeshCore';
import {
  effectiveRepeaterMax,
  getRepeaterGates,
  getRepeaterSettingDef,
  repeaterValuesEqual,
  settingsFor,
  validateRepeaterValue,
  type RepeaterDeviceType,
  type RepeaterGates,
  type RepeaterMode,
  type RepeaterSettingKey,
  type RepeaterSettingValue,
} from '../../utils/meshcoreRepeaterSettings';
import { buildExport, parseImport } from '../../utils/meshcoreRepeaterSettingsExport';
import { estimateLoraAirtimeMs, type LoraParams } from '../../utils/loraAirtime';
import styles from './RepeaterSettingsForm.module.css';

/** An advert is ~125 B on air: 2 header/path, 32 key, 4 time, 64 signature, app data. */
const ADVERT_BYTES = 125;
/** Repeaters that hear a flood advert and repeat it (the spec's worked example). */
const FLOOD_REPEATERS = 50;

type DraftKey = Exclude<keyof RepeaterSettingsValues, 'radio'>;
type Draft = Partial<Record<DraftKey, RepeaterSettingValue>>;

/** Remote command sizes on air (spec P10): `get <key>` ≈ 38 B, `> value` ≈ 22 B. */
const REMOTE_GET_BYTES = 38;
const REMOTE_REPLY_BYTES = 22;

/** Local (P9) draft: lat/lon, name, TX power and radio live in other sections of the config view. */
const LOCAL_DRAFT_KEYS: DraftKey[] = [
  'advertInterval',
  'floodAdvertInterval',
  'floodMax',
  'repeat',
  'af',
  'rxDelay',
  'txDelay',
  'directTxDelay',
  'allowReadOnly',
];

export interface RepeaterSettingsFormProps {
  values: RepeaterSettingsValues;
  guestPasswordSet: boolean;
  /** Firmware version string (`ver`), for the version gates. */
  firmwareVersion?: string | null;
  /** The repeater's radio, for the airtime estimate. */
  radio?: Partial<LoraParams> | null;
  canWrite: boolean;
  disabled?: boolean;
  /** Send the changed fields. Resolves to the server's per-key results, or null when the request failed. */
  onSave: (patch: RepeaterSettingsPatch) => Promise<RepeaterSaveResponse | null>;
  /** Fired after a save, with what was sent and what came back. */
  onSaved?: (patch: RepeaterSettingsPatch, response: RepeaterSaveResponse) => void;
  /** 'local' = serial CLI on a Repeater source (P9); 'remote' = remote admin over RF (P10). */
  mode?: RepeaterMode;
  /** Remote target kind: a Room Server has no forwarding knobs. */
  deviceType?: RepeaterDeviceType;
  /** Remote: groups already read. A group that is not read shows a Read button and cannot be saved. */
  loadedGroups?: ReadonlySet<RemoteSettingsGroup>;
  /** Remote: the group being read now. */
  readingGroup?: RemoteSettingsGroup | null;
  /** Remote: read one group. Nothing reads on mount. */
  onReadGroup?: (group: RemoteSettingsGroup) => void;
  /** Remote: hops to the target, or null when no path is known (each command floods). */
  pathHops?: number | null;
}

function outOfRange(key: RepeaterSettingKey, value: RepeaterSettingValue | undefined, gates: RepeaterGates): boolean {
  if (typeof value !== 'number') return false;
  return !validateRepeaterValue(key, value, gates).ok;
}

function fmtSeconds(ms: number): string {
  const s = ms / 1000;
  return s >= 100 ? String(Math.round(s)) : s.toFixed(s >= 10 ? 0 : 1);
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * The Repeater settings form (#6255 P9 S4): adverts and forwarding, and
 * access. Ranges, units, Off and version gates all come from the shared
 * schema in `utils/meshcoreRepeaterSettings.ts`, so the server and this form
 * cannot drift. A save sends only the fields the user changed, in one request.
 * Secrets are write-only: blank keeps the stored value.
 */
export const RepeaterSettingsForm: React.FC<RepeaterSettingsFormProps> = ({
  values,
  guestPasswordSet,
  firmwareVersion,
  radio,
  canWrite,
  disabled = false,
  onSave,
  onSaved,
  mode = 'local',
  deviceType = 'repeater',
  loadedGroups,
  readingGroup = null,
  onReadGroup,
  pathHops = null,
}) => {
  const { t } = useTranslation();
  const gates = useMemo(() => getRepeaterGates(firmwareVersion), [firmwareVersion]);
  const numbers = useNumberInputScope();
  const remote = mode === 'remote';
  const offered = useMemo(
    () => new Set<RepeaterSettingKey>(settingsFor({ mode, deviceType }).map((d) => d.key)),
    [mode, deviceType],
  );
  const shows = (key: RepeaterSettingKey) => offered.has(key);
  const draftKeys = useMemo<DraftKey[]>(
    () => remote
      ? settingsFor({ mode: 'remote', deviceType })
          .filter((d) => d.remote === 'rw' && !d.secret)
          .map((d) => d.key as DraftKey)
      : LOCAL_DRAFT_KEYS,
    [remote, deviceType],
  );
  const groupRead = (g: RemoteSettingsGroup) => !remote || (loadedGroups?.has(g) ?? false);

  const baseline = useMemo<Draft>(() => {
    const d: Draft = {};
    for (const k of draftKeys) {
      const v = values[k];
      if (v !== undefined) d[k] = v;
    }
    return d;
    // The parent re-reads after a save; key on the content, not the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- #6255 content key
  }, [JSON.stringify(values), draftKeys]);

  const [draft, setDraft] = useState<Draft>(baseline);
  const [adminPassword, setAdminPassword] = useState('');
  const [guestPassword, setGuestPassword] = useState('');
  const [clearGuest, setClearGuest] = useState(false);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<RepeaterSaveResponse['results'] | null>(null);
  const [drifted, setDrifted] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const [includeIdentity, setIncludeIdentity] = useState(false);
  const [importNotes, setImportNotes] = useState<{ key: string; reason: string }[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(baseline);
  }, [baseline]);

  const setField = (key: DraftKey, value: RepeaterSettingValue) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const radioParams: LoraParams | null =
    radio && typeof radio.sf === 'number' && typeof radio.bw === 'number' && typeof radio.cr === 'number'
      ? { sf: radio.sf, bw: radio.bw, cr: radio.cr }
      : null;
  const advertMs = radioParams ? estimateLoraAirtimeMs(ADVERT_BYTES, radioParams) : NaN;
  const advertKnown = Number.isFinite(advertMs);

  // What differs from the repeater now. Secrets join below.
  const changed: RepeaterSettingsPatch = {};
  for (const k of draftKeys) {
    const now = draft[k];
    const was = baseline[k];
    if (now === undefined || was === undefined) continue;
    if (!repeaterValuesEqual(k, now, was)) (changed as Record<string, RepeaterSettingValue>)[k] = now;
  }
  const adminCheck = adminPassword === '' || !shows('adminPassword') ? null : validateRepeaterValue('adminPassword', adminPassword, gates);
  const guestValue = clearGuest ? '' : guestPassword;
  const guestCheck = (guestValue === '' && !clearGuest) || !groupRead('access') ? null : validateRepeaterValue('guestPassword', guestValue, gates);
  if (adminCheck?.ok) changed.adminPassword = adminPassword;
  if (guestCheck?.ok) changed.guestPassword = guestValue;
  const nameCheck = remote && typeof draft.name === 'string' && baseline.name !== undefined && draft.name !== baseline.name
    ? validateRepeaterValue('name', draft.name, gates)
    : null;
  const secretInvalid = adminCheck?.ok === false || guestCheck?.ok === false || nameCheck?.ok === false;
  const changedCount = Object.keys(changed).length;
  const locked = disabled || !canWrite || saving;

  const handleSave = async () => {
    if (changedCount === 0 || numbers.invalid || secretInvalid) return;
    // Normalise (odd advert minutes floor to even) before sending, as the server does.
    const patch: RepeaterSettingsPatch = {};
    for (const [k, v] of Object.entries(changed)) {
      const r = validateRepeaterValue(k as RepeaterSettingKey, v, gates);
      if (r.ok) (patch as Record<string, RepeaterSettingValue>)[k] = r.value;
    }
    setSaving(true);
    setResults(null);
    setDrifted(false);
    setRequestFailed(false);
    try {
      const response = await onSave(patch);
      if (!response) {
        setRequestFailed(true);
        return;
      }
      setResults(response.results);
      setDrifted(response.drifted === true);
      const allOk = Object.values(response.results).every((r) => r.ok);
      if (allOk) {
        setAdminPassword('');
        setGuestPassword('');
        setClearGuest(false);
      }
      onSaved?.(patch, response);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDraft(baseline);
    setAdminPassword('');
    setGuestPassword('');
    setClearGuest(false);
    setResults(null);
    setDrifted(false);
    numbers.reset();
  };

  const resultFor = (key: string) => {
    const r = results?.[key];
    if (!r) return null;
    if (!r.ok && r.code === 'NOT_SENT') {
      return (
        <span className={styles.note} data-testid={`repeater-result-${key}`}>
          {t('meshcore.repeater.remote_not_sent', 'Not sent: the run stopped before this key.')}
        </span>
      );
    }
    if (!r.ok) {
      return (
        <span className={styles.err} role="alert" data-testid={`repeater-result-${key}`}>
          <UiIcon name="alert" size={14} /> {r.error ?? t('meshcore.repeater.result_failed', 'Not saved')}
        </span>
      );
    }
    return (
      <span className={styles.ok} data-testid={`repeater-result-${key}`}>
        <UiIcon name="check" size={14} />{' '}
        {r.changed === false
          ? t('meshcore.repeater.result_unchanged', 'Already set')
          : r.verified === false
            ? t('meshcore.repeater.remote_unverified', 'Sent, not verified')
            : t('meshcore.config.saved', 'Saved')}
      </span>
    );
  };

  /** A number field with a range note for a current value the schema rejects. */
  const numberField = (key: DraftKey, label: string, opts: { step: number; integer?: boolean; offToggle?: boolean }) => {
    const def = getRepeaterSettingDef(key);
    if (!def) return null;
    const current = baseline[key];
    const value = draft[key];
    const max = effectiveRepeaterMax(def, gates);
    const unavailable = current === undefined;
    const isOff = opts.offToggle === true && value === 0;
    const legacy = typeof current === 'number' && outOfRange(key, current, gates) ? current : null;
    const id = `mc-rep-${key}`;
    const rangeText = `${def.min}–${max}${def.unit ? ` ${def.unit}` : ''}`;
    return (
      <div className={styles.field}>
        <label htmlFor={id}>{label}</label>
        <span className={styles.inline}>
          <NumberInputScope scope={numbers}>
            <NumberInput
              id={id}
              min={def.min}
              max={max}
              step={opts.step}
              integer={opts.integer}
              alsoValid={[...(legacy !== null ? [legacy] : []), ...(opts.offToggle ? [0] : [])]}
              value={isOff ? 0 : (typeof value === 'number' ? value : null)}
              onChange={(n) => setField(key, n)}
              disabled={locked || unavailable || isOff}
            />
          </NumberInputScope>
          {def.unit && <span className={styles.unit}>{def.unit}</span>}
          {opts.offToggle && (
            <label className={styles.inline}>
              <input
                type="checkbox"
                checked={isOff}
                disabled={locked || unavailable}
                onChange={(e) => setField(key, e.target.checked ? 0 : (legacy ?? def.min ?? 0))}
                data-testid={`repeater-off-${key}`}
              />
              {t('meshcore.repeater.off', 'Off')}
            </label>
          )}
        </span>
        <span className={styles.note}>
          {unavailable
            ? t('meshcore.repeater.not_read', 'Not read from the device.')
            : t('meshcore.repeater.range', 'Range: {{range}}', { range: rangeText })
          }
          {opts.offToggle && !unavailable ? ` ${t('meshcore.repeater.or_off', 'or Off.')}` : ''}
        </span>
        {legacy !== null && (
          <span className={styles.note} data-testid={`repeater-outofrange-${key}`}>
            {t('meshcore.repeater.out_of_range', {
              value: legacy,
              unit: def.unit ?? '',
              defaultValue: 'The device has {{value}} {{unit}}, outside the range MeshMonitor sets. It stays as it is unless you change it.',
            })}
          </span>
        )}
        {resultFor(key)}
      </div>
    );
  };

  const advertValue = draft.advertInterval;
  const floodValue = draft.floodAdvertInterval;
  const floodMaxValue = draft.floodMax;
  const afValue = draft.af;

  const airtimeText = (ms: number) =>
    advertKnown
      ? t('meshcore.repeater.airtime_each', '{{bytes}} B, about {{seconds}} s on air with this radio', {
          bytes: ADVERT_BYTES,
          seconds: fmtSeconds(ms),
        })
      : t('meshcore.repeater.airtime_unknown', '{{bytes}} B', { bytes: ADVERT_BYTES });

  const advertWarning = (() => {
    if (typeof advertValue !== 'number') return null;
    if (advertValue === 0) {
      return t('meshcore.repeater.warn_advert_off', 'Zero-hop adverts are off. Nearby nodes learn this repeater only from its flood adverts.');
    }
    const perDay = 1440 / advertValue;
    return advertKnown
      ? t('meshcore.repeater.warn_advert', {
          each: airtimeText(advertMs),
          perDay: Math.round(perDay),
          secondsPerDay: fmtSeconds(perDay * advertMs),
          defaultValue: 'Each zero-hop advert is {{each}}. It reaches direct neighbours only, about {{perDay}} a day, {{secondsPerDay}} s of airtime a day.',
        })
      : t('meshcore.repeater.warn_advert_plain', {
          perDay: Math.round(perDay),
          defaultValue: 'Each zero-hop advert reaches direct neighbours only, about {{perDay}} a day.',
        });
  })();

  const floodWarning = (() => {
    if (typeof floodValue !== 'number') return null;
    if (floodValue === 0) {
      return t('meshcore.repeater.warn_flood_off', "Flood adverts are off. Nodes beyond direct range won't learn this repeater until they hear it directly.");
    }
    const hops = typeof floodMaxValue === 'number' ? Math.min(floodMaxValue, 8) : 8;
    const txPerDay = Math.round((24 / floodValue) * (FLOOD_REPEATERS + 1));
    return advertKnown
      ? t('meshcore.repeater.warn_flood', {
          each: airtimeText(advertMs),
          hops,
          hours: floodValue,
          repeaters: FLOOD_REPEATERS,
          txPerDay,
          defaultValue: 'Each flood advert is {{each}} and every repeater that hears it repeats it, up to {{hops}} hops. At {{hours}} h on a mesh with {{repeaters}} repeaters that is about {{txPerDay}} transmissions a day.',
        })
      : t('meshcore.repeater.warn_flood_plain', {
          hops,
          hours: floodValue,
          repeaters: FLOOD_REPEATERS,
          txPerDay,
          defaultValue: 'Every repeater that hears a flood advert repeats it, up to {{hops}} hops. At {{hours}} h on a mesh with {{repeaters}} repeaters that is about {{txPerDay}} transmissions a day.',
        });
  })();

  // ---- Remote: per-group read, cost line, flood warning ----
  const perKeyMs = radioParams
    ? estimateLoraAirtimeMs(REMOTE_GET_BYTES, radioParams) + estimateLoraAirtimeMs(REMOTE_REPLY_BYTES, radioParams)
    : NaN;
  const pathKnown = typeof pathHops === 'number' && pathHops >= 0;
  const groupKeyCount = (g: RemoteSettingsGroup) =>
    settingsFor({ mode: 'remote', deviceType, groups: [g] }).filter((d) => d.getVerb !== null).length;

  const groupHeader = (g: RemoteSettingsGroup) => {
    if (!remote) return null;
    const count = groupKeyCount(g);
    const loaded = groupRead(g);
    const busy = readingGroup !== null;
    let cost: string;
    if (pathKnown) {
      const hops = (pathHops as number) + 1;
      cost = Number.isFinite(perKeyMs)
        ? t('meshcore.repeater.remote_cost', {
            count,
            packets: count * 2,
            hops,
            seconds: fmtSeconds(count * perKeyMs * hops),
            defaultValue: 'Reads {{count}} values: {{packets}} packets over {{hops}} hop(s), about {{seconds}} s on air with your radio.',
          })
        : t('meshcore.repeater.remote_cost_plain', {
            count,
            packets: count * 2,
            hops,
            defaultValue: 'Reads {{count}} values: {{packets}} packets over {{hops}} hop(s).',
          });
    } else {
      cost = t('meshcore.repeater.remote_cost_flood', {
        count,
        packets: count * 2,
        defaultValue: 'Reads {{count}} values: {{packets}} packets.',
      });
    }
    return (
      <div className={styles.readBar} data-testid={`repeater-group-${g}`}>
        <span className={styles.inline}>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onReadGroup?.(g)}
            disabled={disabled || busy || !onReadGroup}
            data-testid={`repeater-read-${g}`}
          >
            {readingGroup === g
              ? t('meshcore.repeater.remote_reading', 'Reading…')
              : loaded
                ? t('meshcore.repeater.remote_read_again', 'Read again')
                : t('meshcore.repeater.remote_read', 'Read')}
          </button>
          {!loaded && readingGroup !== g && (
            <span className={styles.note}>{t('meshcore.repeater.remote_not_read', 'Not read yet.')}</span>
          )}
        </span>
        <span className={styles.note} data-testid={`repeater-cost-${g}`}>{cost}</span>
        {!pathKnown && (
          <p className={styles.warn} role="note" data-testid={`repeater-flood-${g}`}>
            {t('meshcore.repeater.remote_flood_warning', {
              repeaters: FLOOD_REPEATERS,
              defaultValue: 'No path to this node is known, so every command floods: each repeater that hears it sends it again (about {{repeaters}} transmissions per packet on a busy mesh). Learn the path first if you can, with a trace or by waiting for an advert.',
            })}
          </p>
        )}
      </div>
    );
  };

  const txPowerChanged = typeof draft.txPower === 'number' && baseline.txPower !== undefined && draft.txPower !== baseline.txPower;

  // ---- Export / import (from values already read; secrets never included) ----
  const exportable = Object.keys(baseline).length > 0;
  const handleExport = () => {
    const doc = buildExport(values as Partial<Record<RepeaterSettingKey, RepeaterSettingValue>>, {
      deviceType,
      firmware: firmwareVersion ?? null,
      includeIdentity,
    });
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meshcore-${deviceType}-settings.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const handleImportFile = async (file: File) => {
    const text = await readFileText(file);
    const parsed = parseImport(text, { deviceType, gates, mode, includeIdentity });
    if (!parsed.ok) {
      setImportError(parsed.error ?? t('meshcore.repeater.import_bad', 'That file is not a settings export.'));
      setImportNotes(null);
      return;
    }
    setImportError(null);
    setDraft((d) => {
      const next: Draft = { ...d };
      for (const [k, v] of Object.entries(parsed.draft)) {
        if ((draftKeys as string[]).includes(k) && v !== undefined) next[k as DraftKey] = v;
      }
      return next;
    });
    setImportNotes(parsed.notes);
  };

  const repeatOff = draft.repeat === false;
  const afLow = typeof afValue === 'number' && afValue < 1;
  const floodMaxLow = typeof floodMaxValue === 'number' && floodMaxValue <= 2;
  const adminHasError = adminCheck?.ok === false;
  const guestHasError = guestCheck?.ok === false;

  const radioText = typeof values.radio === 'string' ? values.radio : null;

  return (
    <>
      {remote && (
        <div id="meshcore-remote-settings-identity">
          <ConfigSection
            title={t('meshcore.repeater.remote_identity_title', 'Identity & radio')}
            docsUrl={`${MESHCORE_DOCS}#configuration`}
            description={t('meshcore.repeater.remote_identity_hint', 'Name, position and TX power of the remote node. Each value is one encrypted message each way over the mesh.')}
            canWrite={canWrite}
            collapsible
          >
            {groupHeader('identity')}
            <div className={styles.grid}>
              <div className={styles.field}>
                <label htmlFor="mc-rep-name">{t('meshcore.repeater.remote_name', 'Name')}</label>
                <input
                  id="mc-rep-name"
                  type="text"
                  value={typeof draft.name === 'string' ? draft.name : ''}
                  onChange={(e) => setField('name', e.target.value)}
                  disabled={locked || baseline.name === undefined}
                  data-testid="repeater-name"
                />
                <span className={nameCheck?.ok === false ? styles.err : styles.note}>
                  {nameCheck?.ok === false
                    ? t('meshcore.repeater.remote_name_invalid', 'Use 1 to 31 bytes, with no control characters.')
                    : baseline.name === undefined
                      ? t('meshcore.repeater.not_read', 'Not read from the device.')
                      : t('meshcore.repeater.remote_name_hint', '1 to 31 bytes. A new name shows in the next advert.')}
                </span>
                {resultFor('name')}
              </div>
              {numberField('lat', t('meshcore.repeater.remote_lat', 'Latitude'), { step: 0.0001 })}
              {numberField('lon', t('meshcore.repeater.remote_lon', 'Longitude'), { step: 0.0001 })}
              <div className={styles.fieldWide}>
                {numberField('txPower', t('meshcore.repeater.remote_tx_power', 'TX power'), { step: 1, integer: true })}
                {txPowerChanged && (
                  <p className={styles.warn} role="note" data-testid="repeater-warn-txpower">
                    {t('meshcore.repeater.remote_warn_tx_power', 'Lowering TX power can cut this node off from you. It takes effect at once.')}
                  </p>
                )}
              </div>
              <div className={styles.fieldWide}>
                <span className={styles.label}>{t('meshcore.repeater.remote_radio', 'Radio (freq, bandwidth, SF, CR)')}</span>
                <span data-testid="repeater-radio">{radioText ?? '—'}</span>
                <span className={styles.note}>
                  {t('meshcore.repeater.remote_radio_hint', 'Read-only here: a radio change needs a reboot, and a wrong one strands the node.')}
                </span>
              </div>
            </div>
          </ConfigSection>
        </div>
      )}

      <div id={remote ? 'meshcore-remote-settings-adverts' : 'meshcore-config-repeater-adverts'}>
        <ConfigSection
          title={t('meshcore.repeater.adverts_title', 'Adverts & forwarding')}
          docsUrl={`${MESHCORE_DOCS}#configuration`}
          description={remote
            ? t('meshcore.repeater.remote_adverts_hint', 'How often this node announces itself, and what it forwards. A save sends only the fields you edit, one message each over the mesh.')
            : t('meshcore.repeater.adverts_hint', 'How often this repeater announces itself, and what it forwards. A save changes only the fields you edit. Commands go over the serial link and send nothing over the air.')}
          canWrite={canWrite}
          collapsible
        >
          {groupHeader('adverts')}
          <div className={styles.grid}>
            <div className={styles.fieldWide}>
              {numberField('advertInterval', t('meshcore.repeater.advert_interval', 'Advert interval'), { step: 2, integer: true, offToggle: true })}
              {advertWarning && <p className={styles.warn} role="note" data-testid="repeater-warn-advert">{advertWarning}</p>}
            </div>
            <div className={styles.fieldWide}>
              {numberField('floodAdvertInterval', t('meshcore.repeater.flood_advert_interval', 'Flood advert interval'), { step: 1, integer: true, offToggle: true })}
              {floodWarning && <p className={styles.warn} role="note" data-testid="repeater-warn-flood">{floodWarning}</p>}
              {gates.floodAdvertMaxHours < 168 && (
                <p className={styles.note}>
                  {t('meshcore.repeater.flood_cap_note', 'This firmware caps the flood advert interval at {{hours}} h.', { hours: gates.floodAdvertMaxHours })}
                </p>
              )}
            </div>
            {shows('floodMax') && (<div className={styles.fieldWide}>
              {numberField('floodMax', t('meshcore.repeater.flood_max', 'Flood hop limit'), { step: 1, integer: true })}
              {floodMaxLow && (
                <p className={styles.warn} role="note" data-testid="repeater-warn-floodmax">
                  {t('meshcore.repeater.warn_flood_max', 'A limit of 2 hops or less stops this repeater forwarding floods that have travelled further.')}
                </p>
              )}
            </div>)}
            {shows('repeat') && (<div className={styles.fieldWide}>
              <label className={styles.inline}>
                <input
                  type="checkbox"
                  checked={draft.repeat === true}
                  disabled={locked || baseline.repeat === undefined}
                  onChange={(e) => setField('repeat', e.target.checked)}
                  data-testid="repeater-repeat"
                />
                {t('meshcore.repeater.repeat', 'Repeat (forward packets)')}
              </label>
              {resultFor('repeat')}
              {repeatOff && (
                <p className={styles.warn} role="note" data-testid="repeater-warn-repeat">
                  {t('meshcore.repeater.warn_repeat_off', 'With repeat off this node forwards nothing. Nodes that rely on it lose coverage.')}
                </p>
              )}
            </div>)}
            <div className={styles.fieldWide}>
              {numberField('af', t('meshcore.repeater.af', 'Airtime factor'), { step: 0.1 })}
              {afLow && (
                <p className={styles.warn} role="note" data-testid="repeater-warn-af">
                  {t('meshcore.repeater.warn_af', 'Below 1 lets the radio transmit more than half the time. That can break duty-cycle rules, such as the EU sub-band limits.')}
                </p>
              )}
            </div>
            {shows('rxDelay') && numberField('rxDelay', t('meshcore.repeater.rx_delay', 'RX delay'), { step: 0.1 })}
            {shows('txDelay') && numberField('txDelay', t('meshcore.repeater.tx_delay', 'TX delay (flood)'), { step: 0.05 })}
            {shows('directTxDelay') && numberField('directTxDelay', t('meshcore.repeater.direct_tx_delay', 'TX delay (direct)'), { step: 0.05 })}
          </div>
        </ConfigSection>
      </div>

      <div id={remote ? 'meshcore-remote-settings-access' : 'meshcore-config-repeater-access'}>
        <ConfigSection
          title={t('meshcore.repeater.access_title', 'Access')}
          docsUrl={`${MESHCORE_DOCS}#configuration`}
          description={t('meshcore.repeater.access_hint', 'Passwords are write-only: MeshMonitor never reads them back. Leave a field blank to keep the stored value.')}
          canWrite={canWrite}
          collapsible
        >
          {groupHeader('access')}
          <div className={styles.grid}>
            {shows('adminPassword') ? (<div className={styles.field}>
              <label htmlFor="mc-rep-admin-password">{t('meshcore.repeater.admin_password', 'Admin password')}</label>
              <PasswordField
                id="mc-rep-admin-password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder={t('meshcore.repeater.leave_blank', 'Leave blank to keep')}
                disabled={locked}
              />
              <span className={adminHasError ? styles.err : styles.note}>
                {adminHasError
                  ? t('meshcore.repeater.password_invalid_admin', 'Use 1 to 15 bytes, with no control characters.')
                  : t('meshcore.repeater.admin_hint', '1 to 15 bytes.')}
              </span>
              {resultFor('adminPassword')}
            </div>) : (
              <p className={styles.note} data-testid="repeater-admin-console-only">
                {t('meshcore.repeater.remote_admin_console_only', 'Change the admin password from the console below (password <new>). It is not part of this form.')}
              </p>
            )}
            <div className={styles.field}>
              <label htmlFor="mc-rep-guest-password">{t('meshcore.repeater.guest_password', 'Guest password')}</label>
              <PasswordField
                id="mc-rep-guest-password"
                value={guestPassword}
                onChange={(e) => setGuestPassword(e.target.value)}
                placeholder={t('meshcore.repeater.leave_blank', 'Leave blank to keep')}
                disabled={locked || clearGuest || !groupRead('access')}
              />
              <span className={guestHasError ? styles.err : styles.note} data-testid="repeater-guest-state">
                {guestHasError
                  ? t('meshcore.repeater.password_invalid_guest', 'Use up to 15 bytes, with no control characters.')
                  : guestPasswordSet
                    ? t('meshcore.repeater.guest_set', 'A guest password is set.')
                    : t('meshcore.repeater.guest_unset', 'No guest password: guest login is off.')}
              </span>
              {guestPasswordSet && groupRead('access') && (
                <label className={styles.inline}>
                  <input
                    type="checkbox"
                    checked={clearGuest}
                    disabled={locked}
                    onChange={(e) => { setClearGuest(e.target.checked); if (e.target.checked) setGuestPassword(''); }}
                    data-testid="repeater-clear-guest"
                  />
                  {t('meshcore.repeater.clear_guest', 'Turn guest login off')}
                </label>
              )}
              {resultFor('guestPassword')}
            </div>
            <div className={styles.fieldWide}>
              <label className={styles.inline}>
                <input
                  type="checkbox"
                  checked={draft.allowReadOnly === true}
                  disabled={locked || baseline.allowReadOnly === undefined}
                  onChange={(e) => setField('allowReadOnly', e.target.checked)}
                  data-testid="repeater-allow-read-only"
                />
                {t('meshcore.repeater.allow_read_only', 'Allow read-only login')}
              </label>
              {resultFor('allowReadOnly')}
            </div>
          </div>
        </ConfigSection>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={locked || changedCount === 0 || numbers.invalid || secretInvalid}
          data-testid="repeater-save"
        >
          {saving
            ? t('meshcore.config.saving', 'Saving…')
            : t('meshcore.repeater.save', 'Save repeater settings')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleDiscard}
          disabled={locked || (changedCount === 0 && !results)}
        >
          {t('meshcore.repeater.discard', 'Discard changes')}
        </button>
        {requestFailed && (
          <span className={styles.err} role="alert">
            {t('meshcore.repeater.save_failed', 'The save did not go through.')}
          </span>
        )}
        {drifted && (
          <span className={styles.note} role="status">
            {t('meshcore.repeater.drifted', 'The device reports different values than expected. The form shows what it holds now.')}
          </span>
        )}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className="btn-secondary"
          onClick={handleExport}
          disabled={!exportable}
          data-testid="repeater-export"
        >
          <UiIcon name="download" size={14} /> {t('meshcore.repeater.export', 'Export settings')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => fileInput.current?.click()}
          disabled={locked}
          data-testid="repeater-import"
        >
          <UiIcon name="upload" size={14} /> {t('meshcore.repeater.import', 'Import settings')}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className={styles.hiddenFile}
          data-testid="repeater-import-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleImportFile(file);
          }}
        />
        <label className={styles.inline}>
          <input
            type="checkbox"
            checked={includeIdentity}
            onChange={(e) => setIncludeIdentity(e.target.checked)}
            data-testid="repeater-include-identity"
          />
          {t('meshcore.repeater.include_identity', 'Include name, position and radio')}
        </label>
      </div>
      <p className={styles.note}>
        {t('meshcore.repeater.export_hint', 'Exports only values already read, never passwords. An import fills the form; review it and press Save.')}
      </p>
      {importError && (
        <p className={styles.err} role="alert" data-testid="repeater-import-error">{importError}</p>
      )}
      {importNotes && (
        <div className={styles.note} role="status" data-testid="repeater-import-notes">
          {importNotes.length === 0
            ? t('meshcore.repeater.import_done', 'Imported into the form. Nothing is saved until you press Save.')
            : t('meshcore.repeater.import_done_skipped', {
                count: importNotes.length,
                keys: importNotes.map((n) => n.key).join(', '),
                defaultValue: 'Imported into the form; skipped {{count}}: {{keys}}. Nothing is saved until you press Save.',
              })}
        </div>
      )}
    </>
  );
};
