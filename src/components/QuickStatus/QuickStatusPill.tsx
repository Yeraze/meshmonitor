/**
 * Header quick-status pill (#5616).
 *
 * Shows the local node's Status Message and opens a small popover to change it:
 * stock presets, free text with a byte counter, Save and Clear.
 *
 * Mesh impact: a save sends ONE local admin packet to the connected node over
 * its TCP/serial link and nothing over LoRa. The firmware does not broadcast on
 * change; its StatusMessageModule sends the status 2 minutes after boot and
 * then every 12 hours, and never sends an empty one. This component adds no
 * packet and no timer, and the note in the popover tells the user about the
 * delay.
 *
 * The caller decides WHO sees the pill (a signed-in user with
 * `configuration:write` on a connected Meshtastic device source). The pill
 * itself hides when the node's firmware lacks the module (below 2.7.20), which
 * it learns from the same `/api/config/current` read the Configuration tab
 * uses. That read happens on mount and when the popover opens; there is no
 * poll.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import apiService from '../../services/api';
import { UiIcon } from '../icons';
import { useToast } from '../ToastContainer';
import {
  NODE_STATUS_MAX_BYTES,
  truncateToUtf8Bytes,
  utf8ByteLength,
} from '../../utils/statusMessage';
import { STATUS_PRESETS, presetStatusText } from './statusPresets';
import styles from './QuickStatusPill.module.css';

interface QuickStatusPillProps {
  /** Source whose local node owns the status; null resolves the primary. */
  sourceId: string | null;
}

interface QuickStatusData {
  /** False when the node's firmware has no Status Message module. */
  supported: boolean;
  nodeStatus: string;
}

/** Bytes left at which the counter turns to its warning colour. */
const NEAR_LIMIT_BYTES = NODE_STATUS_MAX_BYTES - 10;

const quickStatusQueryKey = (sourceId: string | null) => ['quick-status', sourceId ?? 'default'] as const;

export const QuickStatusPill: React.FC<QuickStatusPillProps> = ({ sourceId }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = quickStatusQueryKey(sourceId);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { data, refetch } = useQuery<QuickStatusData>({
    queryKey,
    queryFn: async () => {
      const config = await apiService.getCurrentConfig(sourceId);
      return {
        supported: config?.supportedModules?.statusmessage === true,
        nodeStatus: config?.moduleConfig?.statusmessage?.nodeStatus ?? '',
      };
    },
    // One read per mount, plus one each time the popover opens. Never a poll.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const mutation = useMutation<unknown, Error, string, { previous?: QuickStatusData }>({
    mutationFn: (nodeStatus: string) => apiService.setModuleConfig('statusmessage', { nodeStatus }, sourceId),
    onMutate: async (nodeStatus) => {
      // Optimistic: show the new status at once. Cancel a read in flight first
      // so its (older) answer cannot land on top of the new value.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<QuickStatusData>(queryKey);
      queryClient.setQueryData<QuickStatusData>(queryKey, { supported: true, nodeStatus });
      return { previous };
    },
    onError: (error, _nodeStatus, context) => {
      // Roll back to what the node had before the failed save.
      if (context?.previous) {
        queryClient.setQueryData<QuickStatusData>(queryKey, context.previous);
      }
      showToast(
        t('quick_status.save_failed', 'Could not save the status: {{error}}', { error: error.message }),
        'error',
      );
    },
  });

  const close = useCallback(() => setOpen(false), []);

  // Close on a click outside the pill and on Escape.
  useEffect(() => {
    if (!open) return;
    // `pointerdown`, not `mousedown`: a tap on a touch screen must close it too.
    const onPointerDown = (event: PointerEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  if (!data?.supported) {
    return null;
  }

  const currentStatus = data.nodeStatus;
  const isSaving = mutation.isPending;
  const draftBytes = utf8ByteLength(draft);
  const trimmedDraft = draft.trim();

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    // Seed the input from the status on screen, then ask the node's config
    // again in case the Configuration tab changed it since the last read.
    setDraft(currentStatus);
    setOpen(true);
    void refetch();
  };

  const save = (nodeStatus: string) => {
    if (isSaving) return;
    close();
    if (nodeStatus === currentStatus) return;
    mutation.mutate(nodeStatus);
  };

  const pillLabel = currentStatus || t('quick_status.set_status', 'Set status');
  const pillTitle = currentStatus
    ? t('quick_status.pill_title', 'Status message: {{status}}', { status: currentStatus })
    : t('quick_status.pill_title_empty', 'Set a status message');

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        type="button"
        className={[styles.pill, currentStatus ? styles.pillSet : '', isSaving ? styles.pillPending : '']
          .filter(Boolean)
          .join(' ')}
        onClick={toggle}
        aria-busy={isSaving}
        title={pillTitle}
        aria-label={pillTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="quick-status-pill"
      >
        <span className={styles.pillIcon}>
          <UiIcon name="announcement" size={15} />
        </span>
        <span className={styles.pillText} data-testid="quick-status-pill-text">{pillLabel}</span>
      </button>

      {open && (
        <div
          className={styles.popover}
          role="dialog"
          aria-label={t('quick_status.title', 'Status message')}
          data-testid="quick-status-popover"
        >
          <div className={styles.heading}>{t('quick_status.title', 'Status message')}</div>

          <div className={styles.presets}>
            {STATUS_PRESETS.map((preset) => {
              const label = t(preset.labelKey, preset.defaultLabel);
              // A translated label can be long; the node still takes 79 bytes.
              const text = truncateToUtf8Bytes(presetStatusText(preset, label));
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={text === currentStatus ? `${styles.preset} ${styles.presetActive}` : styles.preset}
                  onClick={() => save(text)}
                  disabled={isSaving}
                  data-testid={`quick-status-preset-${preset.id}`}
                >
                  <span className={styles.presetEmoji} aria-hidden="true">{preset.emoji}</span>
                  <span className={styles.presetLabel}>{label}</span>
                </button>
              );
            })}
          </div>

          <form
            className={styles.custom}
            onSubmit={(event) => {
              event.preventDefault();
              save(trimmedDraft);
            }}
          >
            <label className={styles.customLabel} htmlFor="quick-status-input">
              {t('quick_status.custom_label', 'Custom status')}
            </label>
            <input
              id="quick-status-input"
              type="text"
              className={styles.input}
              value={draft}
              // Count bytes, not characters, and drop whole characters at the
              // limit so an emoji is never cut in half.
              onChange={(event) => setDraft(truncateToUtf8Bytes(event.target.value))}
              placeholder={t('quick_status.placeholder', 'Type a status...')}
              disabled={isSaving}
              autoComplete="off"
            />
            <span
              className={draftBytes >= NEAR_LIMIT_BYTES ? `${styles.counter} ${styles.counterNearLimit}` : styles.counter}
              data-testid="quick-status-counter"
            >
              {t('quick_status.byte_counter', '{{used}}/{{max}} bytes', { used: draftBytes, max: NODE_STATUS_MAX_BYTES })}
            </span>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.clearButton}
                onClick={() => save('')}
                disabled={isSaving || currentStatus === ''}
                data-testid="quick-status-clear"
              >
                <UiIcon name="close" size={14} />
                {t('quick_status.clear', 'Clear')}
              </button>
              <button
                type="submit"
                className={styles.saveButton}
                disabled={isSaving || trimmedDraft === currentStatus}
                data-testid="quick-status-save"
              >
                <UiIcon name="save" size={14} />
                {t('quick_status.save', 'Save')}
              </button>
            </div>
          </form>

          <p className={styles.note} data-testid="quick-status-note">
            <span className={styles.noteIcon}><UiIcon name="info" size={14} /></span>
            <span>
              {t(
                'quick_status.broadcast_note',
                'Your node sends its status to the mesh about every 12 hours, not when you change it. Other nodes may not see a change for up to 12 hours. Clearing the status is not sent: other nodes keep the last one they heard.',
              )}
            </span>
          </p>
        </div>
      )}
    </div>
  );
};

export default QuickStatusPill;
