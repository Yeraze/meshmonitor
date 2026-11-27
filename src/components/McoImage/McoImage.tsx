import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons/UiIcon';
import { copyTextToClipboard } from '../../utils/clipboard.js';
import type { DecodedMcoImage } from '../../utils/mcoImage/types.js';
import { useMcoImageDecode } from './useMcoImageDecode.js';
import type { McoCodec } from './loadMcoCodec.js';
import styles from './McoImage.module.css';

/** Display target for the longest side, in CSS pixels. */
const MCO_DISPLAY_PX = 192;
/** Larger target for an IM4 image that carries text, so small captions stay readable. */
const MCO_DISPLAY_TEXT_PX = 256;
const MAX_DPR = 3;
const ARIA_TEXT_MAX = 300;
const COPIED_MS = 2000;

interface McoImageProps {
  /** The trimmed message: the exact payload, used for tooltip, copy and text fallback. */
  payload: string;
}

function displayWidth(w: number, h: number, target: number): number {
  const longest = Math.max(w, h);
  if (longest <= target) return w * Math.floor(target / longest);
  return Math.round((w * target) / longest);
}

function deviceScale(): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  return Math.min(Math.max(dpr, 1), MAX_DPR);
}

function captionText(captions: readonly string[]): string {
  const text = captions.join('; ');
  return text.length > ARIA_TEXT_MAX ? `${text.slice(0, ARIA_TEXT_MAX)}\u2026` : text;
}

type CopyState = 'idle' | 'copied' | 'failed';

const McoImageReady: React.FC<{ payload: string; image: DecodedMcoImage; codec: McoCodec }> = ({
  payload,
  image,
  codec,
}) => {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { width, height } = image;
  const isVector = image.format === 'im4';
  const hasText = image.format === 'im4' && image.captions.length > 0;
  const cssWidth = displayWidth(width, height, hasText ? MCO_DISPLAY_TEXT_PX : MCO_DISPLAY_PX);
  const dpr = isVector ? deviceScale() : 1;
  // Vector images draw at device resolution; IM3 keeps one canvas pixel per image pixel.
  const pixelWidth = isVector ? Math.round(cssWidth * dpr) : width;
  const pixelHeight = isVector ? Math.max(1, Math.round((cssWidth * dpr * height) / width)) : height;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (image.format === 'im4') {
      codec.paintMcoImageV4(ctx, image.document, {
        pixelWidth,
        pixelHeight,
        fontFamily: getComputedStyle(canvas).fontFamily || 'sans-serif',
      });
      return;
    }
    const data = ctx.createImageData(image.width, image.height);
    data.data.set(image.rgba);
    ctx.putImageData(data, 0, 0);
  }, [image, codec, pixelWidth, pixelHeight]);

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

  const ariaLabel =
    image.format === 'im4' && image.captions.length > 0
      ? t('mco_image.aria_label_text', 'MCOimg image, {{width}} by {{height}}, text: {{text}}', {
          width,
          height,
          text: captionText(image.captions),
        })
      : t('mco_image.aria_label', 'MCOimg image, {{width}} by {{height}} pixels', {
          width,
          height,
        });

  return (
    <span
      className={styles.root}
      data-testid="mco-image"
      data-format={image.format}
      data-width={width}
      data-height={height}
    >
      <canvas
        ref={canvasRef}
        className={isVector ? `${styles.canvas} ${styles.vector}` : styles.canvas}
        width={pixelWidth}
        height={pixelHeight}
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-describedby={tooltipId}
        style={{ width: `${cssWidth}px`, aspectRatio: `${width} / ${height}` }}
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
  return <McoImageReady payload={payload} image={state.image} codec={state.codec} />;
};

export default McoImage;
