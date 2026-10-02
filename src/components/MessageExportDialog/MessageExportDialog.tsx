/**
 * Filtered message export dialog (#5517).
 *
 * Builds the filter set for `GET /api/messages/export` and downloads the CSV
 * through ApiService. The server applies the same read permissions as the
 * message views, so this dialog only offers what the caller can already see
 * (sources and channels come from `/api/unified/channels`).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { UiIcon } from '../icons';
import apiService, { type MessageExportParams } from '../../services/api';
import styles from './MessageExportDialog.module.css';

export interface MessageExportChannel {
  name: string;
  sources: Array<{ sourceId: string; sourceName: string }>;
}

export interface MessageExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  channels: MessageExportChannel[];
  /** Channel to pre-select (the one the page is showing). */
  initialChannel?: string;
}

type ChannelMode = 'all' | 'selected';

function splitTerms(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `datetime-local` value (browser local time) → UTC epoch ms. */
function localInputToMs(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

const MessageExportDialog: React.FC<MessageExportDialogProps> = ({ isOpen, onClose, channels, initialChannel }) => {
  const { t } = useTranslation();

  const sources = useMemo(() => {
    const byId = new Map<string, string>();
    for (const c of channels) for (const s of c.sources) byId.set(s.sourceId, s.sourceName);
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [channels]);

  // Track the sources the user UNticked, so a source that appears later (the
  // channel list polls) starts ticked and no re-seeding is needed.
  const [excludedSources, setExcludedSources] = useState<Set<string>>(new Set());
  const [channelMode, setChannelMode] = useState<ChannelMode>('all');
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set());
  const [type, setType] = useState<'all' | 'channels' | 'dms'>('all');
  const [include, setInclude] = useState('');
  const [exclude, setExclude] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [sender, setSender] = useState('');
  const [includeReactions, setIncludeReactions] = useState(false);
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh state each time the dialog opens.
  useEffect(() => {
    if (!isOpen) return;
    setExcludedSources(new Set());
    setChannelMode(initialChannel ? 'selected' : 'all');
    setSelectedChannels(new Set(initialChannel ? [initialChannel] : []));
    setType('all');
    setInclude('');
    setExclude('');
    setStart('');
    setEnd('');
    setSender('');
    setIncludeReactions(false);
    setTimeZone(browserTimeZone());
    setBusy(false);
    setError(null);
  }, [isOpen, initialChannel]);

  const selectedSources = useMemo(
    () => new Set(sources.filter((s) => !excludedSources.has(s.id)).map((s) => s.id)),
    [sources, excludedSources],
  );

  const visibleChannels = useMemo(
    () => channels.filter((c) => c.sources.some((s) => selectedSources.has(s.sourceId))),
    [channels, selectedSources],
  );

  const startMs = localInputToMs(start);
  const endMs = localInputToMs(end);
  const rangeInvalid = startMs !== undefined && endMs !== undefined && startMs > endMs;
  const noSources = selectedSources.size === 0;
  const noChannels = channelMode === 'selected' && selectedChannels.size === 0 && type !== 'dms';
  const canExport = !busy && !noSources && !noChannels && !rangeInvalid;

  const toggle = (set: Set<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const runExport = async () => {
    const params: MessageExportParams = {
      // All sources ticked ⇒ omit, so DM-only sources (absent from the
      // channel list) are still included.
      sources: selectedSources.size === sources.length ? undefined : Array.from(selectedSources),
      channels: channelMode === 'selected' ? Array.from(selectedChannels) : undefined,
      type,
      include: splitTerms(include),
      exclude: splitTerms(exclude),
      start: startMs,
      end: endMs,
      sender: sender.trim() || undefined,
      includeReactions,
      tz: timeZone.trim() || 'UTC',
    };
    setBusy(true);
    setError(null);
    try {
      await apiService.exportMessagesCsv(params);
      onClose();
    } catch (err) {
      setError(t('unified.messages.export.error', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('unified.messages.export.title')} maxWidth="560px">
      <div className={styles.body}>
        <p className={styles.help}>{t('unified.messages.export.help')}</p>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>{t('unified.messages.export.sources')}</legend>
          {sources.length === 0 && <p className={styles.hint}>{t('unified.messages.export.no_sources')}</p>}
          <div className={styles.checkList}>
            {sources.map((s) => (
              <label key={s.id} className={styles.check}>
                <input
                  type="checkbox"
                  checked={selectedSources.has(s.id)}
                  onChange={() => setExcludedSources((prev) => toggle(prev, s.id))}
                />
                {s.name}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.group}>
          <legend className={styles.legend}>{t('unified.messages.export.channels')}</legend>
          <div className={styles.row}>
            <label className={styles.check}>
              <input
                type="radio"
                name="message-export-channel-mode"
                checked={channelMode === 'all'}
                onChange={() => setChannelMode('all')}
              />
              {t('unified.messages.export.all_channels')}
            </label>
            <label className={styles.check}>
              <input
                type="radio"
                name="message-export-channel-mode"
                checked={channelMode === 'selected'}
                onChange={() => setChannelMode('selected')}
              />
              {t('unified.messages.export.selected_channels')}
            </label>
          </div>
          {channelMode === 'selected' && (
            <div className={styles.checkList}>
              {visibleChannels.map((c) => (
                <label key={c.name} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={selectedChannels.has(c.name)}
                    onChange={() => setSelectedChannels((prev) => toggle(prev, c.name))}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          )}
          <label className={styles.field}>
            {t('unified.messages.export.type')}
            <select className={styles.input} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="all">{t('unified.messages.export.type_all')}</option>
              <option value="channels">{t('unified.messages.export.type_channels')}</option>
              <option value="dms">{t('unified.messages.export.type_dms')}</option>
            </select>
          </label>
        </fieldset>

        <div className={styles.row}>
          <label className={styles.field}>
            {t('unified.messages.export.include')}
            <input
              className={styles.input}
              type="text"
              value={include}
              placeholder={t('unified.messages.export.terms_placeholder')}
              onChange={(e) => setInclude(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            {t('unified.messages.export.exclude')}
            <input
              className={styles.input}
              type="text"
              value={exclude}
              placeholder={t('unified.messages.export.terms_placeholder')}
              onChange={(e) => setExclude(e.target.value)}
            />
          </label>
        </div>
        <p className={styles.hint}>{t('unified.messages.export.terms_hint')}</p>

        <div className={styles.row}>
          <label className={styles.field}>
            {t('unified.messages.export.start')}
            <input className={styles.input} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className={styles.field}>
            {t('unified.messages.export.end')}
            <input className={styles.input} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <p className={styles.hint}>{t('unified.messages.export.range_hint', { zone: browserTimeZone() })}</p>
        {rangeInvalid && <p className={styles.error}>{t('unified.messages.export.range_invalid')}</p>}

        <div className={styles.row}>
          <label className={styles.field}>
            {t('unified.messages.export.sender')}
            <input
              className={styles.input}
              type="text"
              value={sender}
              placeholder="!abcd1234"
              onChange={(e) => setSender(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            {t('unified.messages.export.timezone')}
            <input className={styles.input} type="text" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
          </label>
        </div>

        <label className={styles.check}>
          <input type="checkbox" checked={includeReactions} onChange={(e) => setIncludeReactions(e.target.checked)} />
          {t('unified.messages.export.include_reactions')}
        </label>

        <p className={styles.hint}>{t('unified.messages.export.limit_hint')}</p>
        {error && <p className={styles.error} role="alert">{error}</p>}

        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className={styles.primary} onClick={() => void runExport()} disabled={!canExport}>
            <UiIcon name="download" size={16} />
            {busy ? t('unified.messages.export.exporting') : t('unified.messages.export.submit')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default MessageExportDialog;
