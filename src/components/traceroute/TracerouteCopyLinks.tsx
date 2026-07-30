/**
 * TracerouteCopyLinks — three small text links ("Copy Forward" / "Copy
 * Return" / "Copy Both") in the Node Details traceroute box, letting a user
 * grab a plain-text rendering of the currently displayed traceroute for
 * pasting elsewhere (chat, ticket, bug report).
 *
 * Text is built by the pure `formatTracerouteText` helper
 * (`src/utils/traceroute.tsx`), which mirrors `formatTracerouteRoute`'s path
 * semantics but returns a plain string (or `null` when a leg has no usable
 * data).
 *
 * Clipboard flow: `navigator.clipboard.writeText` is tried only in a secure
 * context; when that API is unavailable OR the write is rejected, a small
 * fallback modal opens with the text in a readonly, auto-selected textarea
 * so the user can copy manually. There is no `document.execCommand` path —
 * the modal IS the fallback (see `MeshtasticContactShare.tsx` for the
 * precedent this deliberately diverges from).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeviceInfo } from '../../types/device';
import { formatTracerouteText } from '../../utils/traceroute';
import Modal from '../common/Modal';
import styles from './TracerouteCopyLinks.module.css';

export interface TracerouteCopyLinksProps {
  route?: string | null;
  routeBack?: string | null;
  snrTowards?: string | null;
  snrBack?: string | null;
  fromNodeNum: number;
  toNodeNum: number;
  nodes: DeviceInfo[];
}

type CopyTarget = 'forward' | 'return' | 'both';

const COPIED_CONFIRMATION_MS = 2000;

export function TracerouteCopyLinks({
  route,
  routeBack,
  snrTowards,
  snrBack,
  fromNodeNum,
  toNodeNum,
  nodes,
}: TracerouteCopyLinksProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  // Auto-select the fallback text so a manual Ctrl/Cmd+C just works.
  useEffect(() => {
    if (fallbackText !== null && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [fallbackText]);

  const forwardLine = formatTracerouteText(route ?? null, snrTowards ?? null, fromNodeNum, toNodeNum, nodes);
  const returnLine = formatTracerouteText(routeBack ?? null, snrBack ?? null, toNodeNum, fromNodeNum, nodes);

  if (!forwardLine && !returnLine) return null;

  const separator = t('messages.traceroute_copy_separator', ': ');
  const forwardText = forwardLine
    ? `${t('messages.traceroute_leg_forward', 'Forward')}${separator}${forwardLine}`
    : null;
  const returnText = returnLine
    ? `${t('messages.traceroute_leg_return', 'Return')}${separator}${returnLine}`
    : null;
  const bothText = forwardText && returnText ? `${forwardText}\n${returnText}` : null;

  const copy = async (text: string, target: CopyTarget) => {
    const canUseClipboard = window.isSecureContext && !!navigator.clipboard?.writeText;
    if (canUseClipboard) {
      try {
        await navigator.clipboard.writeText(text);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        setCopied(target);
        copiedTimerRef.current = setTimeout(() => setCopied(null), COPIED_CONFIRMATION_MS);
        return;
      } catch {
        // Fall through to the manual-copy fallback modal below.
      }
    }
    setFallbackText(text);
  };

  return (
    <div className={styles.row}>
      {forwardText && (
        <button type="button" className={styles.link} onClick={() => copy(forwardText, 'forward')}>
          {t('messages.traceroute_copy_forward', 'Copy Forward')}
        </button>
      )}
      {returnText && (
        <button type="button" className={styles.link} onClick={() => copy(returnText, 'return')}>
          {t('messages.traceroute_copy_return', 'Copy Return')}
        </button>
      )}
      {bothText && (
        <button type="button" className={styles.link} onClick={() => copy(bothText, 'both')}>
          {t('messages.traceroute_copy_both', 'Copy Both')}
        </button>
      )}
      {copied && (
        <span className={styles.confirm}>{t('messages.traceroute_copied', 'Copied!')}</span>
      )}

      <Modal
        isOpen={fallbackText !== null}
        onClose={() => setFallbackText(null)}
        title={t('messages.traceroute_copy_fallback_title', 'Copy traceroute')}
        maxWidth="420px"
      >
        <p className={styles.fallbackHint}>
          {t(
            'messages.traceroute_copy_fallback_hint',
            'Automatic copy is unavailable over an insecure connection — select and copy the text below.',
          )}
        </p>
        <textarea
          ref={textareaRef}
          readOnly
          className={styles.fallbackTextarea}
          value={fallbackText ?? ''}
          onFocus={e => e.currentTarget.select()}
          aria-label={t('messages.traceroute_copy_fallback_title', 'Copy traceroute')}
        />
        <div className={styles.fallbackActions}>
          <button type="button" className={styles.fallbackClose} onClick={() => setFallbackText(null)}>
            {t('common.close', 'Close')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
