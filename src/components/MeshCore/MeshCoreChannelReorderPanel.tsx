/**
 * MeshCoreChannelReorderPanel — "Reorder slots on device" mode for the
 * MeshCore Channels settings page (#5379).
 *
 * Unlike the display-only sort in the Channels message view (#5392), this
 * REWRITES the companion's channel slots. The server does the heavy lifting
 * (POST /api/sources/:id/meshcore/channels/reorder): it writes one slot at a
 * time with read-back, rolls back on any failure, and remaps stored history
 * and rules so they follow their channel. This panel only collects the order,
 * confirms, and reports the outcome, including the device state after a
 * failure.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { UiIcon } from '../icons';
import { DRAG_HANDLE_TOUCH_STYLE } from '../dragHandleStyle';
import { useCsrfFetch } from '../../hooks/useCsrfFetch';
import { formatMeshCoreChannelName } from '../../utils/meshcoreHelpers';
import styles from './MeshCoreChannelReorderPanel.module.css';

export interface ReorderChannelRow {
  id: number;
  name: string;
}

interface Props {
  baseUrl: string;
  sourceId: string;
  /** Configured channels in slots 1+, as the settings page lists them. */
  channels: ReorderChannelRow[];
  /** Called after the server answered, so the page reloads its channel list. */
  onFinished: () => void;
  onClose: () => void;
}

type Outcome =
  | { kind: 'applied'; data: AppliedData }
  | { kind: 'rolled_back'; message: string }
  | { kind: 'inconsistent'; message: string; slots: Array<{ slot: number; name: string | null; unknown?: boolean }> }
  | { kind: 'refused'; message: string };

interface AppliedData {
  moves: Array<{ from: number; to: number }>;
  remap: {
    permissionsDropped: number;
    automationsToReview: Array<{ id: string; name: string; slots: number[] }>;
  };
}

const SortableRow: React.FC<{
  id: number;
  label: string;
  index: number;
  count: number;
  busy: boolean;
  onMove: (index: number, delta: -1 | 1) => void;
}> = ({ id, label, index, count, busy, onMove }) => {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: busy });
  const to = index + 1;
  const moved = to !== id;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`${styles.row}${isDragging ? ` ${styles.rowDragging}` : ''}`}
      data-testid={`mc-reorder-row-${id}`}
      {...attributes}
    >
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        className={styles.handle}
        style={DRAG_HANDLE_TOUCH_STYLE}
        title={t('meshcore.channels.reorder.drag', 'Drag to reorder')}
      >
        <UiIcon name="dragHandle" size={18} />
      </span>
      <span className={styles.name}>{label}</span>
      <span className={`${styles.slots}${moved ? ` ${styles.moved}` : ''}`}>
        {moved
          ? t('meshcore.channels.reorder.slot_move', 'Slot {{from}} to {{to}}', { from: id, to })
          : t('meshcore.channels.reorder.slot_same', 'Slot {{slot}}', { slot: id })}
      </span>
      <button
        type="button"
        className={styles.arrow}
        onClick={() => onMove(index, -1)}
        disabled={busy || index === 0}
        aria-label={t('meshcore.channels.reorder.move_up', 'Move {{name}} up', { name: label })}
      >
        <UiIcon name="chevronUp" size={16} />
      </button>
      <button
        type="button"
        className={styles.arrow}
        onClick={() => onMove(index, 1)}
        disabled={busy || index === count - 1}
        aria-label={t('meshcore.channels.reorder.move_down', 'Move {{name}} down', { name: label })}
      >
        <UiIcon name="chevronDown" size={16} />
      </button>
    </li>
  );
};

export const MeshCoreChannelReorderPanel: React.FC<Props> = ({ baseUrl, sourceId, channels, onFinished, onClose }) => {
  const { t } = useTranslation();
  const csrfFetch = useCsrfFetch();
  const initial = useMemo(() => channels.filter((c) => c.id >= 1).sort((a, b) => a.id - b.id), [channels]);
  const [order, setOrder] = useState<number[]>(() => initial.map((c) => c.id));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // The page reloads its list after every attempt. If the set of channels
  // changed (a refused stale order, or a channel added elsewhere), start the
  // draft again from the fresh list rather than resubmitting a stale one.
  const initialKey = initial.map((c) => c.id).join(',');
  useEffect(() => {
    const ids = initialKey ? initialKey.split(',').map(Number) : [];
    setOrder((prev) => {
      const same = prev.length === ids.length && prev.every((id) => ids.includes(id));
      return same ? prev : ids;
    });
  }, [initialKey]);

  const byId = useMemo(() => new Map(initial.map((c) => [c.id, c])), [initial]);
  const labelFor = useCallback(
    (id: number) => formatMeshCoreChannelName(
      byId.get(id)?.name ?? '',
      t('meshcore.channels.unnamed', 'Channel {{idx}}', { idx: id }),
    ),
    [byId, t],
  );
  // Also true when only the gaps close: [1, 3] packs channel 3 into slot 2.
  const changed = order.some((id, i) => id !== i + 1);
  const moveCount = order.filter((id, i) => id !== i + 1).length;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback((e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setOrder((prev) => arrayMove(prev, prev.indexOf(Number(active.id)), prev.indexOf(Number(over.id))));
  }, []);

  const handleMove = useCallback((index: number, delta: -1 | 1) => {
    setOrder((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      return arrayMove(prev, index, target);
    });
  }, []);

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setConfirming(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirming, busy]);

  const submit = useCallback(async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const response = await csrfFetch(
        `${baseUrl}/api/sources/${encodeURIComponent(sourceId)}/meshcore/channels/reorder`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order }),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (response.ok && body?.success) {
        if (body.data?.status === 'applied') setOutcome({ kind: 'applied', data: body.data as AppliedData });
        else setOutcome({ kind: 'refused', message: t('meshcore.channels.reorder.unchanged', 'The device already has this order. Nothing was written.') });
      } else if (body?.code === 'CHANNEL_REORDER_ROLLED_BACK') {
        setOutcome({ kind: 'rolled_back', message: String(body.error ?? '') });
      } else if (body?.code === 'CHANNEL_REORDER_INCONSISTENT') {
        setOutcome({
          kind: 'inconsistent',
          message: String(body.error ?? ''),
          slots: Array.isArray(body.result?.deviceSlots) ? body.result.deviceSlots : [],
        });
      } else {
        setOutcome({ kind: 'refused', message: String(body?.error ?? `HTTP ${response.status}`) });
      }
    } catch (err) {
      setOutcome({ kind: 'refused', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setConfirming(false);
      onFinished();
    }
  }, [baseUrl, sourceId, order, csrfFetch, onFinished, t]);

  const done = outcome?.kind === 'applied' || outcome?.kind === 'rolled_back' || outcome?.kind === 'inconsistent';

  return (
    <div className={styles.panel} data-testid="mc-channel-reorder-panel">
      <p className={styles.hint}>
        {t(
          'meshcore.channels.reorder.hint',
          'Drag channels, or use the arrows, into the order you want on the device. Channels are packed into slots 1, 2, 3 and so on, which also closes any empty slots. Public stays in slot 0.',
        )}
      </p>

      {!done && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <ul className={styles.list}>
              {order.map((id, index) => (
                <SortableRow
                  key={id}
                  id={id}
                  label={labelFor(id)}
                  index={index}
                  count={order.length}
                  busy={busy}
                  onMove={handleMove}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      {busy && (
        <div className={styles.busy} role="status" aria-live="polite">
          <UiIcon name="refresh" size={16} />
          {t('meshcore.channels.reorder.writing', 'Writing channel slots to the device and checking each one… Keep the device connected.')}
        </div>
      )}

      {outcome && <OutcomeBox outcome={outcome} />}

      <div className={styles.actions}>
        {!done && (
          <button
            type="button"
            className={styles.primary}
            onClick={() => setConfirming(true)}
            disabled={busy || !changed}
            data-testid="mc-reorder-save"
          >
            {t('meshcore.channels.reorder.save', 'Save order to device')}
          </button>
        )}
        <button type="button" onClick={onClose} disabled={busy}>
          {done ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
        </button>
      </div>

      {confirming && (
        <div className={styles.overlay} onClick={() => { if (!busy) setConfirming(false); }}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label={t('meshcore.channels.reorder.confirm_title', 'Rewrite channel slots on the device?')}
            data-testid="mc-reorder-confirm"
            onClick={(e) => e.stopPropagation()}
          >
            <h4>{t('meshcore.channels.reorder.confirm_title', 'Rewrite channel slots on the device?')}</h4>
            <p>
              {t(
                'meshcore.channels.reorder.confirm_body',
                'This rewrites {{count}} channel slot(s) on the companion, one at a time, and checks each write. It uses the serial or TCP link only; nothing is sent over the radio.',
                { count: moveCount },
              )}
            </p>
            <ul className={styles.dialogList}>
              <li>{t('meshcore.channels.reorder.confirm_history', 'Message history, unread markers, channel permissions, scopes and the MeshCore auto-ack, auto-announce, auto-responder and timer settings follow their channel.')}</li>
              <li>{t('meshcore.channels.reorder.confirm_vn', 'Apps connected through the Virtual Node are disconnected so they reload the new channel list.')}</li>
              <li>{t('meshcore.channels.reorder.confirm_automations', 'Automations that pick a channel by number are not changed. You will get a list of any to check.')}</li>
              <li>{t('meshcore.channels.reorder.confirm_rollback', 'If a write fails, the original order is written back.')}</li>
            </ul>
            <p className={styles.warning} role="alert">
              <UiIcon name="alert" size={16} />
              {t('meshcore.channels.reorder.confirm_warning', 'Do not disconnect or reboot the device until this finishes.')}
            </p>
            <div className={styles.dialogActions}>
              <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className={styles.primary}
                onClick={() => { void submit(); }}
                disabled={busy}
                data-testid="mc-reorder-confirm-go"
              >
                {t('meshcore.channels.reorder.confirm_go', 'Rewrite slots')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const OutcomeBox: React.FC<{ outcome: Outcome }> = ({ outcome }) => {
  const { t } = useTranslation();
  if (outcome.kind === 'applied') {
    const review = outcome.data.remap?.automationsToReview ?? [];
    const dropped = outcome.data.remap?.permissionsDropped ?? 0;
    return (
      <div className={`${styles.result} ${styles.resultSuccess}`} role="status" data-testid="mc-reorder-result">
        <p className={styles.resultTitle}>
          <UiIcon name="check" size={16} />
          {t('meshcore.channels.reorder.applied', 'Channels reordered on the device. History and settings followed their channel.')}
        </p>
        {dropped > 0 && (
          <p>{t('meshcore.channels.reorder.permissions_dropped', '{{count}} channel permission grant(s) were removed because their channel moved to slot 8 or higher, which has no per-channel permission. Check user permissions if needed.', { count: dropped })}</p>
        )}
        {review.length > 0 && (
          <>
            <p>{t('meshcore.channels.reorder.automations_review', 'These automations name a moved slot by number and were not changed. Check that they still point at the channel you want:')}</p>
            <ul className={styles.resultList}>
              {review.map((a) => (
                <li key={a.id}>
                  {a.name} ({t('meshcore.channels.reorder.automation_slots', 'slot {{slots}}', { slots: a.slots.join(', ') })})
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }
  if (outcome.kind === 'rolled_back') {
    return (
      <div className={`${styles.result} ${styles.resultWarning}`} role="alert" data-testid="mc-reorder-result">
        <p className={styles.resultTitle}>
          <UiIcon name="alert" size={16} />
          {t('meshcore.channels.reorder.rolled_back', 'The reorder failed and was undone. The device is back in its original order, and nothing else changed.')}
        </p>
        <p>{outcome.message}</p>
      </div>
    );
  }
  if (outcome.kind === 'inconsistent') {
    return (
      <div className={`${styles.result} ${styles.resultError}`} role="alert" data-testid="mc-reorder-result">
        <p className={styles.resultTitle}>
          <UiIcon name="error" size={16} />
          {t('meshcore.channels.reorder.inconsistent', 'The reorder failed and the undo could not be confirmed. No channel was removed, but one may sit in the wrong slot or appear twice. History and settings were not changed.')}
        </p>
        <p>{outcome.message}</p>
        {outcome.slots.length > 0 && (
          <>
            <p>{t('meshcore.channels.reorder.device_slots', 'Last known device slots:')}</p>
            <ul className={styles.resultList}>
              {outcome.slots.map((s) => (
                <li key={s.slot}>
                  {s.unknown
                    ? t('meshcore.channels.reorder.slot_unknown', 'Slot {{slot}}: unknown', { slot: s.slot })
                    : t('meshcore.channels.reorder.slot_named', 'Slot {{slot}}: {{name}}', {
                      slot: s.slot,
                      name: s.name || t('meshcore.channels.reorder.no_name', '(no name)'),
                    })}
                </li>
              ))}
            </ul>
          </>
        )}
        <p>{t('meshcore.channels.reorder.inconsistent_next', 'Reconnect the device, reload this page, and check the channel list. Running the reorder again restores a clean order.')}</p>
      </div>
    );
  }
  return (
    <div className={`${styles.result} ${styles.resultWarning}`} role="alert" data-testid="mc-reorder-result">
      <p className={styles.resultTitle}>
        <UiIcon name="info" size={16} />
        {t('meshcore.channels.reorder.refused', 'Nothing was written to the device.')}
      </p>
      <p>{outcome.message}</p>
    </div>
  );
};

export default MeshCoreChannelReorderPanel;
