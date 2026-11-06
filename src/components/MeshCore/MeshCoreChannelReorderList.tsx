/**
 * Reorder mode for MeshCore list views (#5379).
 *
 * Sets a MeshMonitor-side display order only; no device writes, no airtime.
 * Rows drag by their handle (mouse, touch, keyboard via dnd-kit) and also carry
 * explicit move up / move down buttons, so reordering never depends on a drag
 * gesture. Save hands the new id order to the parent; Cancel drops it.
 *
 * Generic over the row id type `K` (#6148): channels pass integer slot ids and
 * rooms pass public-key strings. dnd-kit's `UniqueIdentifier` already covers
 * both, so a string id matches the `SortableContext` items the same way a
 * numeric one does.
 */
import React, { useCallback, useState } from 'react';
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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { UiIcon } from '../icons';
import { DRAG_HANDLE_TOUCH_STYLE } from '../dragHandleStyle';
import { moveItem, type OrderKey } from './meshcoreChannelOrder';
import styles from './MeshCoreChannelReorderList.module.css';

export interface ReorderChannel<K extends OrderKey = number> {
  id: K;
  label: string;
  /** Optional leading kind marker rendered before the label (#6228). MeshCore
   *  channels pass a `MeshCoreChannelMarker`; rooms leave it out. */
  marker?: React.ReactNode;
}

interface MeshCoreChannelReorderListProps<K extends OrderKey> {
  /** Rows in the order the list starts from. */
  channels: ReorderChannel<K>[];
  onSave: (order: K[]) => void;
  onCancel: () => void;
}

interface SortableRowProps {
  channel: ReorderChannel<OrderKey>;
  index: number;
  count: number;
  onMove: (from: number, to: number) => void;
}

const SortableRow: React.FC<SortableRowProps> = ({ channel, index, count, onMove }) => {
  const { t } = useTranslation();
  // `id` is the same value as the SortableContext items — dnd-kit looks rows
  // up by it, so the two must match exactly (#5324). A string id (room) or a
  // numeric id (channel) both work as long as they are consistent.
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: channel.id });

  return (
    <li
      ref={setNodeRef}
      className={`${styles.row} ${isDragging ? styles.dragging : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="mc-channel-reorder-row"
    >
      <span
        ref={setActivatorNodeRef}
        className={styles.handle}
        style={DRAG_HANDLE_TOUCH_STYLE}
        title={t('meshcore.channels.order.drag', 'Drag to reorder')}
        {...attributes}
        {...listeners}
        aria-label={t('meshcore.channels.order.drag_named', 'Drag {{name}} to reorder', { name: channel.label })}
      >
        <UiIcon name="dragHandle" size={18} />
      </span>
      <span className={styles.name}>{channel.marker}{channel.label}</span>
      <button
        type="button"
        className={styles.move}
        onClick={() => onMove(index, index - 1)}
        disabled={index === 0}
        title={t('meshcore.channels.order.move_up', 'Move up')}
        aria-label={t('meshcore.channels.order.move_up_named', 'Move {{name}} up', { name: channel.label })}
      >
        <UiIcon name="sortAscending" size={15} />
      </button>
      <button
        type="button"
        className={styles.move}
        onClick={() => onMove(index, index + 1)}
        disabled={index === count - 1}
        title={t('meshcore.channels.order.move_down', 'Move down')}
        aria-label={t('meshcore.channels.order.move_down_named', 'Move {{name}} down', { name: channel.label })}
      >
        <UiIcon name="sortDescending" size={15} />
      </button>
    </li>
  );
};

export function MeshCoreChannelReorderList<K extends OrderKey = number>({
  channels,
  onSave,
  onCancel,
}: MeshCoreChannelReorderListProps<K>) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ReorderChannel<K>[]>(channels);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleMove = useCallback((from: number, to: number) => {
    setDraft(prev => moveItem(prev, from, to));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setDraft(prev => {
      const from = prev.findIndex(c => c.id === active.id);
      const to = prev.findIndex(c => c.id === over.id);
      return moveItem(prev, from, to);
    });
  }, []);

  return (
    <div className={styles.container}>
      <p className={styles.hint}>
        {t(
          'meshcore.channels.order.hint',
          'Drag channels or use the arrows. This changes the order in MeshMonitor only; the channel slots on the device stay as they are.',
        )}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={draft.map(c => c.id)} strategy={verticalListSortingStrategy}>
          <ol className={styles.list}>
            {draft.map((c, i) => (
              <SortableRow key={c.id} channel={c} index={i} count={draft.length} onMove={handleMove} />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button type="button" className={styles.save} onClick={() => onSave(draft.map(c => c.id))}>
          <UiIcon name="save" size={14} /> {t('meshcore.channels.order.save', 'Save order')}
        </button>
      </div>
    </div>
  );
}
