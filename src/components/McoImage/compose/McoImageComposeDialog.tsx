import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../common/Modal';
import { UiIcon } from '../../icons/UiIcon';
import McoImage from '../McoImage';
import { COMPOSE_PROFILES, SIZE_LADDER } from '../../../utils/mcoImage/compose/profiles.js';
import { targetDims } from '../../../utils/mcoImage/compose/resize.js';
import type { McoImageComposeDialogProps, RgbaImage } from '../../../utils/mcoImage/compose/types.js';
import { PaletteProfile, type PaletteProfileId } from '../../../utils/mcoImage/v3/constants.js';
import { decodeImageFile, McoImageFileError } from './decodeImageFile.js';
import {
  useMcoImageCompose,
  type ComposeMode,
  type EncodingView,
  type ManualSettings,
} from './useMcoImageCompose.js';
import styles from './McoImageComposeDialog.module.css';

const MAX_UPSCALE = 4;
const MAX_LADDER_SIZE = 128;
const DEFAULT_MANUAL: ManualSettings = { size: 32, profile: PaletteProfile.master8, dither: false };

const PALETTE_KEY: Record<number, string> = {
  [PaletteProfile.mono]: 'palette_mono',
  [PaletteProfile.master4]: 'palette_master4',
  [PaletteProfile.master8]: 'palette_master8',
  [PaletteProfile.master16]: 'palette_master16',
  [PaletteProfile.master32]: 'palette_master32',
  [PaletteProfile.master64]: 'palette_master64',
  [PaletteProfile.grayscale8]: 'palette_gray8',
  [PaletteProfile.grayscale16]: 'palette_gray16',
  [PaletteProfile.grayscale32]: 'palette_gray32',
};

const PALETTE_DEFAULT: Record<string, string> = {
  palette_mono: 'Black and white',
  palette_master4: '4 colors',
  palette_master8: '8 colors',
  palette_master16: '16 colors',
  palette_master32: '32 colors',
  palette_master64: '64 colors',
  palette_gray8: '8 grays',
  palette_gray16: '16 grays',
  palette_gray32: '32 grays',
};

function ladderFor(srcLongest: number): number[] {
  const cap = Math.min(MAX_LADDER_SIZE, srcLongest * MAX_UPSCALE);
  const sizes = SIZE_LADDER.filter((s) => s <= cap);
  return sizes.length > 0 ? sizes : [SIZE_LADDER[0]];
}

interface PanelProps {
  format: 'IM3' | 'IM4';
  view: EncodingView;
  limit: number;
  onUse(text: string): void;
  paletteName(profile: PaletteProfileId): string;
}

function EncodingPanel({ format, view, limit, onUse, paletteName }: PanelProps): React.ReactElement {
  const { t } = useTranslation();
  const reasonId = useId();
  const hasText = view.text !== null && view.bytes !== null;
  const over = hasText && !view.fits ? (view.bytes as number) - limit : 0;
  const pending = !hasText && (view.status === 'searching' || view.status === 'idle');
  const canUse = hasText && view.fits;
  const reason = canUse
    ? null
    : pending
      ? t('mco_image.compose.use_disabled_pending', { defaultValue: 'Still working on a result.' })
      : t('mco_image.compose.use_disabled_nofit', { defaultValue: 'Does not fit in this conversation.' });

  const statusText = (() => {
    switch (view.status) {
      case 'searching':
        return t('mco_image.compose.status_searching', { defaultValue: 'Searching…' });
      case 'optimizing':
        return t('mco_image.compose.status_optimizing', { defaultValue: 'Optimizing…' });
      case 'ready':
        return t('mco_image.compose.status_ready', { defaultValue: 'Ready' });
      case 'nofit':
        return t('mco_image.compose.status_nofit', { defaultValue: "Doesn't fit" });
      case 'failed':
        return t('mco_image.compose.status_failed', { defaultValue: 'Failed' });
      default:
        return '';
    }
  })();

  return (
    <section className={styles.panel} aria-label={format} data-testid={`mco-panel-${format.toLowerCase()}`}>
      <h3 className={styles.panelTitle}>{format}</h3>
      <p className={styles.status} role="status" aria-live="polite">
        {statusText}
      </p>
      <div className={styles.preview}>
        {hasText ? <McoImage payload={view.text as string} /> : <div className={styles.previewEmpty} aria-hidden="true" />}
      </div>
      {hasText && view.w !== null && view.h !== null && view.profile !== null ? (
        <p className={styles.meta}>
          {t('mco_image.compose.dimensions', {
            defaultValue: '{{width}}×{{height}} · {{palette}}',
            width: view.w,
            height: view.h,
            palette: paletteName(view.profile),
          })}
        </p>
      ) : null}
      {hasText ? (
        <p className={styles.bytes}>
          <span>
            {t('mco_image.compose.bytes', {
              defaultValue: '{{used}} / {{limit}} bytes',
              used: view.bytes,
              limit,
            })}
          </span>{' '}
          <span className={view.fits ? styles.badgeFit : styles.badgeOver}>
            <UiIcon name={view.fits ? 'check' : 'error'} size={12} />{' '}
            {view.fits
              ? t('mco_image.compose.fits', { defaultValue: 'Fits' })
              : t('mco_image.compose.over_by', { defaultValue: 'Over by {{over}} bytes', over })}
          </span>
        </p>
      ) : null}
      <button
        type="button"
        className={styles.useButton}
        disabled={!canUse}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => view.text !== null && onUse(view.text)}
      >
        {format === 'IM3'
          ? t('mco_image.compose.use_im3', { defaultValue: 'Use IM3' })
          : t('mco_image.compose.use_im4', { defaultValue: 'Use IM4' })}
      </button>
      {reason ? (
        <p id={reasonId} className={styles.reason}>
          {reason}
        </p>
      ) : null}
    </section>
  );
}

function ComposeBody({ limit, draftNotEmpty, onChoose }: Omit<McoImageComposeDialogProps, 'open' | 'onClose'>): React.ReactElement {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileHintId = useId();
  const [fileName, setFileName] = useState<string | null>(null);
  const [source, setSource] = useState<RgbaImage | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<ComposeMode>('auto');
  const [manual, setManual] = useState<ManualSettings>(DEFAULT_MANUAL);

  const state = useMcoImageCompose({ source, limit, mode, manual, enabled: true });
  const ladder = useMemo(() => ladderFor(source ? Math.max(source.width, source.height) : MAX_LADDER_SIZE), [source]);
  const sizeIndex = Math.max(0, ladder.findIndex((s) => s >= manual.size) === -1 ? ladder.length - 1 : ladder.findIndex((s) => s >= manual.size));
  const dims = source ? targetDims(source.width, source.height, ladder[sizeIndex]) : null;

  const paletteName = useCallback(
    (p: PaletteProfileId) => {
      const k = PALETTE_KEY[p] ?? 'palette_mono';
      return t(`mco_image.compose.${k}`, { defaultValue: PALETTE_DEFAULT[k] });
    },
    [t],
  );

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      setFileError(null);
      try {
        const decoded = await decodeImageFile(file);
        setFileName(file.name);
        setSource(decoded);
      } catch (err) {
        const kind = err instanceof McoImageFileError ? err.kind : 'decode';
        setSource(null);
        setFileName(null);
        setFileError(
          kind === 'type'
            ? t('mco_image.compose.error_type', { defaultValue: 'Choose a PNG or JPEG image.' })
            : kind === 'size'
              ? t('mco_image.compose.error_size', { defaultValue: 'That file is too large (25 MB at most).' })
              : t('mco_image.compose.error_decode', { defaultValue: 'That image could not be read.' }),
        );
      }
    },
    [t],
  );

  const enterManual = useCallback(() => {
    setMode('manual');
    const w = state.im3.status !== 'idle' && state.im3.profile !== null && state.im3.w !== null ? state.im3 : null;
    if (w && w.profile !== null && w.w !== null && w.h !== null) {
      setManual((m) => ({ ...m, profile: w.profile as PaletteProfileId, size: Math.max(w.w as number, w.h as number) }));
    }
  }, [state.im3]);

  return (
    <div className={styles.body}>
      <div className={styles.fileRow}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
          className={styles.fileInput}
          tabIndex={-1}
          aria-hidden="true"
          data-testid="mco-file-input"
          onChange={onFile}
        />
        <button type="button" className={styles.button} onClick={() => fileInputRef.current?.click()} aria-describedby={fileHintId}>
          <UiIcon name="upload" size={14} /> {t('mco_image.compose.choose_file', { defaultValue: 'Choose image' })}
        </button>
        <span className={styles.fileName}>{fileName ?? ''}</span>
      </div>
      <p id={fileHintId} className={styles.hint}>
        {t('mco_image.compose.file_hint', { defaultValue: 'PNG or JPEG. The image stays in your browser.' })}
      </p>
      {fileError ? (
        <p className={styles.error} role="alert">
          {fileError}
        </p>
      ) : null}

      <p className={styles.limit}>
        {t('mco_image.compose.limit', { defaultValue: 'Limit for this conversation: {{limit}} bytes', limit })}
      </p>

      <div className={styles.modeRow} role="group" aria-label={t('mco_image.compose.title', { defaultValue: 'Insert image' })}>
        <button
          type="button"
          className={mode === 'auto' ? styles.segActive : styles.seg}
          aria-pressed={mode === 'auto'}
          onClick={() => setMode('auto')}
        >
          {t('mco_image.compose.mode_auto', { defaultValue: 'Auto' })}
        </button>
        <button
          type="button"
          className={mode === 'manual' ? styles.segActive : styles.seg}
          aria-pressed={mode === 'manual'}
          onClick={enterManual}
        >
          {t('mco_image.compose.mode_manual', { defaultValue: 'Manual' })}
        </button>
      </div>

      {mode === 'manual' ? (
        <div className={styles.controls}>
          <label className={styles.control}>
            <span>
              {t('mco_image.compose.size', { defaultValue: 'Size' })}
              {dims ? ` ${dims.w}×${dims.h}` : ''}
            </span>
            <input
              type="range"
              min={0}
              max={ladder.length - 1}
              step={1}
              value={sizeIndex}
              onChange={(e) => setManual((m) => ({ ...m, size: ladder[Number(e.target.value)] }))}
            />
          </label>
          <label className={styles.control}>
            <span>{t('mco_image.compose.palette', { defaultValue: 'Palette' })}</span>
            <select
              value={manual.profile}
              onChange={(e) => setManual((m) => ({ ...m, profile: Number(e.target.value) as PaletteProfileId }))}
            >
              {COMPOSE_PROFILES.map((p) => (
                <option key={p} value={p}>
                  {paletteName(p)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.checkControl}>
            <input
              type="checkbox"
              checked={manual.dither}
              onChange={(e) => setManual((m) => ({ ...m, dither: e.target.checked }))}
            />
            <span>{t('mco_image.compose.dither', { defaultValue: 'Dither' })}</span>
          </label>
        </div>
      ) : null}

      {source ? (
        <>
          <div className={styles.panels}>
            <EncodingPanel format="IM3" view={state.im3} limit={limit} onUse={onChoose} paletteName={paletteName} />
            <EncodingPanel format="IM4" view={state.im4} limit={limit} onUse={onChoose} paletteName={paletteName} />
          </div>
          {state.highTimedOut ? (
            <p className={styles.hint}>
              {t('mco_image.compose.status_high_timeout', {
                defaultValue: 'Extra optimizing took too long and was stopped. The result above is still valid.',
              })}
            </p>
          ) : null}
        </>
      ) : null}

      <p className={styles.hint}>
        {t('mco_image.compose.hint_one_message', {
          defaultValue: 'Sent as one ordinary text message. Adding text turns it back into text.',
        })}
      </p>
      {draftNotEmpty ? (
        <p className={styles.hint}>
          {t('mco_image.compose.hint_replaces_draft', { defaultValue: 'Replaces your current draft.' })}
        </p>
      ) : null}
    </div>
  );
}

export function McoImageComposeDialog({
  open,
  limit,
  draftNotEmpty,
  onChoose,
  onClose,
}: McoImageComposeDialogProps): React.ReactElement | null {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t('mco_image.compose.title', { defaultValue: 'Insert image' })}
      maxWidth="720px"
    >
      <ComposeBody limit={limit} draftNotEmpty={draftNotEmpty} onChoose={onChoose} />
    </Modal>
  );
}

export default McoImageComposeDialog;
