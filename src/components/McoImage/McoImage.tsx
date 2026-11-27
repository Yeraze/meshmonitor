import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons/UiIcon';
import { copyTextToClipboard } from '../../utils/clipboard.js';
import type { DecodedMcoImage } from '../../utils/mcoImage/types.js';
import { useMcoImageDecode } from './useMcoImageDecode.js';
import styles from './McoImage.module.css';

/** Display target for the longest side, in CSS pixels. */
const MCO_DISPLAY_PX = 192;
const COPIED_MS = 2000;

interface McoImageProps {
  /** The trimmed message: the exact payload, used for tooltip, copy and text fallback. */
  payload: string;
}

function displayWidth(w: number, h: number): number {
  const longest = Math.max(w, h);
  if (longest <= MCO_DISPLAY_PX) return w * Math.floor(MCO_DISPLAY_PX / longest);
  return Math.round((w * MCO_DISPLAY_PX) / longest);
}

type CopyState = 'idle' | 'copied' | 'failed';

const McoImageReady: React.FC<{ payload: string; image: DecodedMcoImage }> = ({
  payload,
  image,
}) => {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width, height, rgba } = image;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const data = ctx.createImageData(width, height);
    data.data.set(rgba);
    ctx.putImageData(data, 0, 0);
  }, [width, height, rgba]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyTextToClipboard(payload);
    setCopy(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy('idle'), COPIED_MS);
  };

  const label =
    copy === 'copied'
      ? t('mco_image.copied', 'Copied')
      : copy === 'failed'
        ? t('mco_image.copy_failed', 'Copy failed')
        : t('mco_image.copy', 'Copy original message');

  return (
    <span className={styles.root} data-testid="mco-image" data-width={width} data-height={height}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        width={width}
        height={height}
        role="img"
        tabIndex={0}
        aria-label={t('mco_image.aria_label', 'MCOimg image, {{width}} by {{height}} pixels', {
          width,
          height,
        })}
        aria-describedby={tooltipId}
        style={{ width: `${displayWidth(width, height)}px`, aspectRatio: `${width} / ${height}` }}
        onMouseEnter={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <span role="tooltip" id={tooltipId} className={styles.tooltip} hidden={!open}>
        {payload}
      </span>
      <button type="button" className={styles.copy} onClick={handleCopy}>
        <UiIcon name={copy === 'copied' ? 'check' : 'copy'} size={14} />
        {label}
      </button>
    </span>
  );
};

export const McoImage: React.FC<McoImageProps> = ({ payload }) => {
  const state = useMcoImageDecode(payload);
  if (state.status !== 'ready') {
    return (
      <span className={styles.text} data-testid="mco-image-text">
        {payload}
      </span>
    );
  }
  return <McoImageReady payload={payload} image={state.image} />;
};

export default McoImage;
