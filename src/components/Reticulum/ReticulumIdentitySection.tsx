/**
 * ReticulumIdentitySection — the LXMF identity block of a Reticulum source's
 * Configuration page (#6011): destination hash, display name, "Announce now"
 * and the periodic announce interval. Shown in every mode.
 *
 * Routes (all `ok()` envelopes, so bodies are read via `.data`):
 *   GET  /api/sources/:id/reticulum/announce-settings   configuration:read
 *   PUT  /api/sources/:id/reticulum/display-name        configuration:write
 *   PUT  /api/sources/:id/reticulum/announce-interval   configuration:write
 *   POST /api/sources/:id/reticulum/announce            configuration:write
 *
 * The server enforces the 60 s "Announce now" cooldown and answers 429 with
 * `retryAfterSeconds`; this view only mirrors it, counting down from what
 * the server said. Saving the name never announces.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import { UiIcon } from '../icons';
import styles from './ReticulumIdentitySection.module.css';

interface AnnounceSettings {
  connected: boolean;
  destinationHash: string | null;
  displayName: string | null;
  maxDisplayNameLength: number;
  announceIntervalHours: number;
  cooldownSeconds: number;
  lastAnnounceAt: number | null;
  cooldownRemainingSeconds: number;
  nextPeriodicAnnounceAt: number | null;
}

/** Interval choices, in hours. 0 = off (the default). The server accepts any whole 1–24. */
const ANNOUNCE_INTERVAL_CHOICES = [0, 1, 2, 3, 6, 12, 24] as const;

const DEFAULT_MAX_NAME = 64;

interface ReticulumIdentitySectionProps {
  sourceId: string;
  canWrite: boolean;
}

function unwrap<T>(res: unknown): T | null {
  if (res && typeof res === 'object' && 'data' in (res as Record<string, unknown>)) {
    return (res as { data: T }).data;
  }
  return (res as T) ?? null;
}

export const ReticulumIdentitySection: React.FC<ReticulumIdentitySectionProps> = ({ sourceId, canWrite }) => {
  const { t } = useTranslation();
  const base = `/api/sources/${encodeURIComponent(sourceId)}/reticulum`;

  const [settings, setSettings] = useState<AnnounceSettings | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [intervalDraft, setIntervalDraft] = useState(0);
  const [saving, setSaving] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Client-clock time the cooldown ends, from the server's remaining seconds. */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const data = unwrap<AnnounceSettings>(await api.get<unknown>(`${base}/announce-settings`));
      if (!data) return;
      setSettings(data);
      setNameDraft(data.displayName ?? '');
      setIntervalDraft(data.announceIntervalHours ?? 0);
      setCooldownUntil(Date.now() + (data.cooldownRemainingSeconds ?? 0) * 1000);
      setNow(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('reticulum.identity.loadError', 'Failed to load the LXMF identity settings'));
    }
  }, [base, t]);

  useEffect(() => { void load(); }, [load]);

  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  // Tick once a second while the cooldown runs, so the button counts down.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (tick >= cooldownUntil) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const maxName = settings?.maxDisplayNameLength ?? DEFAULT_MAX_NAME;
  const trimmedName = nameDraft.trim();
  const nameChanged = settings !== null && trimmedName !== (settings.displayName ?? '');
  const intervalChanged = settings !== null && intervalDraft !== settings.announceIntervalHours;
  const nameTooLong = Array.from(trimmedName).length > maxName;
  const connected = settings?.connected ?? false;

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      let applied = true;
      if (nameChanged) {
        const res = unwrap<{ applied: boolean }>(await api.put<unknown>(`${base}/display-name`, { name: trimmedName }));
        applied = res?.applied ?? false;
      }
      if (intervalChanged) {
        await api.put(`${base}/announce-interval`, { hours: intervalDraft });
      }
      setMessage(
        nameChanged && !applied
          ? t('reticulum.identity.savedOffline', 'Saved. The name is applied when the source next connects.')
          : t('reticulum.identity.saved', 'Saved. Press Announce now to send the name to the network.'),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('reticulum.identity.saveError', 'Failed to save'));
      await load();
    } finally {
      setSaving(false);
    }
  };

  const announce = async () => {
    setAnnouncing(true);
    setError(null);
    setMessage(null);
    try {
      await api.post(`${base}/announce`);
      setMessage(t('reticulum.identity.announced', 'Announce sent.'));
      await load();
    } catch (e) {
      // ApiError carries the server's 429 `retryAfterSeconds` (services/api.ts).
      const err = e as { status?: number; retryAfterSeconds?: number };
      if (err.status === 429 && typeof err.retryAfterSeconds === 'number') {
        setCooldownUntil(Date.now() + err.retryAfterSeconds * 1000);
        setNow(Date.now());
      } else {
        setError(e instanceof Error ? e.message : t('reticulum.identity.announceError', 'Failed to announce'));
      }
    } finally {
      setAnnouncing(false);
    }
  };

  const formatTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : t('reticulum.identity.never', 'Never'));

  return (
    <section className={styles.section} data-testid="reticulum-identity-section">
      <h3 className={styles.heading}>{t('reticulum.identity.heading', 'LXMF Identity')}</h3>
      {error && <div className={styles.error} role="alert">{error}</div>}
      {message && <div className={styles.success} aria-live="polite">{message}</div>}

      <dl className={styles.facts}>
        <dt>{t('reticulum.identity.destinationHash', 'Destination hash')}</dt>
        <dd>
          {settings?.destinationHash
            ? <code className={styles.hash}>{settings.destinationHash}</code>
            : <span className={styles.muted}>{t('reticulum.identity.notConnected', 'Not connected')}</span>}
        </dd>
        <dt>{t('reticulum.identity.lastAnnounce', 'Last announce')}</dt>
        <dd>{formatTime(settings?.lastAnnounceAt ?? null)}</dd>
        {settings?.nextPeriodicAnnounceAt ? (
          <>
            <dt>{t('reticulum.identity.nextAnnounce', 'Next periodic announce')}</dt>
            <dd>{formatTime(settings.nextPeriodicAnnounceAt)}</dd>
          </>
        ) : null}
      </dl>

      <div className={styles.grid}>
        <label className={styles.field}>
          <span>{t('reticulum.identity.displayName', 'Display name')}</span>
          <input
            type="text"
            value={nameDraft}
            maxLength={maxName}
            disabled={!canWrite || saving}
            placeholder={t('reticulum.identity.anonymous', 'Anonymous')}
            aria-invalid={nameTooLong || undefined}
            onChange={e => setNameDraft(e.target.value)}
          />
          <span className={styles.help}>
            {t('reticulum.identity.displayNameHelp', 'Up to {{max}} characters. Leave empty to stay anonymous. Saving does not announce.', { max: maxName })}
          </span>
        </label>

        <label className={styles.field}>
          <span>{t('reticulum.identity.interval', 'Periodic announce')}</span>
          <select
            value={intervalDraft}
            disabled={!canWrite || saving}
            onChange={e => setIntervalDraft(Number(e.target.value))}
          >
            {ANNOUNCE_INTERVAL_CHOICES.map(h => (
              <option key={h} value={h}>
                {h === 0
                  ? t('reticulum.identity.intervalOff', 'Off')
                  : t('reticulum.identity.intervalHours', 'Every {{count}} h', { count: h })}
              </option>
            ))}
          </select>
          {intervalDraft > 0 && (
            <span className={styles.warning}>
              <UiIcon name="alert" size={12} />
              {t(
                'reticulum.identity.intervalWarning',
                'Each announce goes out on every interface, LoRa included, and transport nodes repeat it. Keep the interval long on a busy or slow network.',
              )}
            </span>
          )}
        </label>
      </div>

      <div className={styles.actions}>
        <button
          className={styles.primaryBtn}
          onClick={() => void save()}
          disabled={!canWrite || saving || nameTooLong || (!nameChanged && !intervalChanged)}
        >
          {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
        </button>
        <button
          className={styles.secondaryBtn}
          onClick={() => void announce()}
          disabled={!canWrite || !connected || announcing || cooldownLeft > 0}
          title={!connected ? t('reticulum.identity.announceOffline', 'Connect the source to announce') : undefined}
        >
          <UiIcon name="send" size={14} />
          {cooldownLeft > 0
            ? t('reticulum.identity.announceCooldown', 'Announce now ({{seconds}} s)', { seconds: cooldownLeft })
            : t('reticulum.identity.announceNow', 'Announce now')}
        </button>
      </div>
      <p className={styles.help}>
        {t(
          'reticulum.identity.announceHelp',
          'An announce tells the network this identity exists and carries its display name. Once a minute at most.',
        )}
      </p>
    </section>
  );
};

export default ReticulumIdentitySection;
