/**
 * ChannelsConfigSection — Meshtastic channel slots (#5829).
 *
 * Lists the configured channels (role != DISABLED) as cards that open in
 * place, the same model the MeshCore channel list and the automation lists
 * use. Each card has its own "Save to device": one set_channel admin write,
 * with no SaveBar and no batching across channels. "Add channel" opens a new
 * card on the next free slot (0-7).
 *
 * Kept from before: drag-to-reorder followed by "Apply Order" (the device
 * reboots), JSON export / import per slot, the Channel Database key-collision
 * warning (#3644), the AEAD badge and the position-precision readout.
 */
import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { UiIcon } from '../icons';
import AeadBadge from '../channels/AeadBadge';
import { DRAG_HANDLE_TOUCH_STYLE } from '../dragHandleStyle';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import apiService from '../../services/api';
import { useToast } from '../ToastContainer';
import { Channel } from '../../types/device';
import { logger } from '../../utils/logger';
import { useSettings } from '../../contexts/SettingsContext';
import { useAuth } from '../../contexts/AuthContext';
import { useResolvedSourceId } from '../../hooks/useResolvedSourceId';
import { formatPrecisionAccuracy } from '../../utils/distance';
import { NO_ENCRYPTION_PSK, pskEncryptionStatus, type PskEncryptionStatus } from '../../utils/publicChannel';
import { NumberInput } from '../common/NumberInput';
import Modal from '../common/Modal';
import { ConfigSection } from '../shared/config/ConfigSection';
import { ConfigItemCard, ConfigItemCardButton, type ConfigItemChip } from '../shared/config/ConfigItemCard';
import { ChannelKeyField } from '../shared/config/ChannelKeyField';
import { ChannelEncryptionLabel } from '../shared/config/ChannelEncryptionLabel';
import { DiscardChangesDialog } from '../shared/config/DiscardChangesDialog';
import { useDiscardGuard } from '../shared/config/useDiscardGuard';
import { generateChannelKey, isValidChannelKey } from '../shared/config/channelKey';
import styles from './ChannelsConfigSection.module.css';

/** A device channel sharing its key with a differently-named Channel Database
 *  (server-decryption) entry (#3644). */
interface ChannelCollision {
  channelId: number;
  channelName: string;
  dbId: number;
  dbName: string;
}

const SLOT_COUNT = 8;
const ALL_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7];
const MAX_NAME_LENGTH = 11;
/** Key lengths the firmware accepts: none, the 1-byte default index, AES-128, AES-256. */
const PSK_ALLOWED_BYTES = [0, 1, 16, 32] as const;
const PSK_GENERATE_BYTES = 32;

// Resolve encryption status for a Channel: prefer the server-derived
// `encryptionStatus` field (always present on API responses) and fall back
// to deriving from `psk`. The API only sends `psk` to authorized writers
// (issue #2951), so unauthorized callers MUST rely on `encryptionStatus`.
const channelEncryptionStatus = (channel: Pick<Channel, 'encryptionStatus' | 'psk'>): PskEncryptionStatus =>
  channel.encryptionStatus ?? pskEncryptionStatus(channel.psk);

/** A slot holds a channel unless it is missing or DISABLED (role 0). */
const isConfigured = (channel: Channel | undefined): channel is Channel =>
  !!channel && channel.role !== 0;

interface ChannelDraft {
  name: string;
  psk: string;
  role: number;
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  positionPrecision: number;
}

interface EditingState {
  slotId: number;
  /** A slot opened by "Add channel" rather than an existing channel. */
  isNew: boolean;
  draft: ChannelDraft;
  /** The draft the card opened with, for Cancel and the unsaved check. */
  original: ChannelDraft;
}

/**
 * The `psk` to send on save (#5826). The server keeps the stored key when
 * `psk` is absent and turns encryption off for an explicit ''. So send '' only
 * when the user emptied a field that held a key (or a new channel); a field
 * that opened empty (no key, or a reader who never got one) keeps whatever
 * the device has.
 */
const pskForSave = (edit: EditingState): string | undefined => {
  if (edit.draft.psk !== '') return edit.draft.psk;
  return edit.isNew || edit.original.psk !== '' ? '' : undefined;
};

const draftsEqual = (a: ChannelDraft, b: ChannelDraft): boolean =>
  a.name === b.name &&
  a.psk === b.psk &&
  a.role === b.role &&
  a.uplinkEnabled === b.uplinkEnabled &&
  a.downlinkEnabled === b.downlinkEnabled &&
  a.positionPrecision === b.positionPrecision;

interface ChannelsConfigSectionProps {
  baseUrl?: string;
  channels: Channel[];
  onChannelsUpdated?: () => void;
}

/** Wrapper that makes a channel card draggable. */
const SortableChannelCard: React.FC<{
  // Must match the SortableContext `items` entries exactly — dnd-kit looks
  // items up with `indexOf`, so a string id against numeric items leaves every
  // card at index -1 and nothing shifts while dragging (#5324).
  id: number;
  disabled: boolean;
  dragLabel: string;
  children: React.ReactNode;
}> = ({ id, disabled, dragLabel, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      className={`${styles.sortable} ${isDragging ? styles.dragging : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
    >
      <div
        ref={setActivatorNodeRef}
        {...listeners}
        data-testid="channel-drag-handle"
        className={`${styles.handle} ${disabled ? styles.handleDisabled : ''}`}
        // #5233 — see DRAG_HANDLE_TOUCH_STYLE for why each property matters on a phone.
        style={DRAG_HANDLE_TOUCH_STYLE}
        title={dragLabel}
      >
        <UiIcon name="dragHandle" size={20} />
      </div>
      <div className={styles.sortableBody}>{children}</div>
    </div>
  );
};

const ChannelsConfigSection: React.FC<ChannelsConfigSectionProps> = ({
  channels,
  onChannelsUpdated
}) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { distanceUnit } = useSettings();
  const { hasPermission } = useAuth();
  // Channel writes require a concrete sourceId; resolve context source or primary.
  const sourceId = useResolvedSourceId();
  // The server also checks channel_N:write on each channel write.
  const canWrite = hasPermission('configuration', 'write', { sourceId });

  // #3644: device channels whose PSK matches a server-side decryption (Channel
  // Database) entry under a DIFFERENT name. Detected server-side because
  // readers don't receive raw PSKs.
  const [channelCollisions, setChannelCollisions] = useState<ChannelCollision[]>([]);
  useEffect(() => {
    let cancelled = false;
    const qs = sourceId ? `?sourceId=${encodeURIComponent(sourceId)}` : '';
    apiService.get<{ collisions: ChannelCollision[] }>(`/api/channels/collisions${qs}`)
      .then(res => { if (!cancelled) setChannelCollisions(res.collisions ?? []); })
      .catch(() => { if (!cancelled) setChannelCollisions([]); });
    return () => { cancelled = true; };
  }, [sourceId, channels]);
  const collisionDbNamesByChannelId = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const c of channelCollisions) {
      const list = m.get(c.channelId) ?? [];
      list.push(c.dbName);
      m.set(c.channelId, list);
    }
    return m;
  }, [channelCollisions]);

  const channelBySlot = useMemo(() => {
    const m = new Map<number, Channel>();
    for (const ch of channels) if (ch.id >= 0 && ch.id < SLOT_COUNT) m.set(ch.id, ch);
    return m;
  }, [channels]);

  const [editing, setEditing] = useState<EditingState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const dirty = !!editing && (editing.isNew || !draftsEqual(editing.draft, editing.original));
  const discard = useDiscardGuard(dirty);

  const [showImportModal, setShowImportModal] = useState(false);
  const [importSlotId, setImportSlotId] = useState<number>(0);
  const [importFileContent, setImportFileContent] = useState<string>('');
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isReordering, setIsReordering] = useState(false);
  const [activeDragId, setActiveDragId] = useState<number | null>(null);
  // Track the current slot order for drag-and-drop (array of original slot indices)
  const [slotOrder, setSlotOrder] = useState<number[]>(ALL_SLOTS);
  const originalOrder = useRef<number[]>(ALL_SLOTS);

  // Reset slot order when channels are refreshed from server (e.g., after successful reorder)
  useEffect(() => {
    setSlotOrder(ALL_SLOTS);
    originalOrder.current = ALL_SLOTS;
  }, [channels]);

  const hasReorderChanges = useMemo(
    () => slotOrder.some((v, i) => v !== originalOrder.current[i]),
    [slotOrder],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Drag only reorders the local list; nothing is written until Apply Order.
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(Number(event.active.id));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSlotOrder(prev => arrayMove(prev, prev.indexOf(Number(active.id)), prev.indexOf(Number(over.id))));
    }
  }, []);

  const handleApplyReorder = async () => {
    if (!hasReorderChanges) return;
    setIsReordering(true);
    try {
      await apiService.reorderDeviceChannels(slotOrder, sourceId);
      showToast(t('channels_config.reorder_success', 'Channels reordered successfully. Device will reboot.'), 'success');
      originalOrder.current = [...slotOrder];
      onChannelsUpdated?.();
    } catch (error) {
      logger.error('Error reordering channels:', error);
      const errorMsg = error instanceof Error ? error.message : t('channels_config.reorder_failed', 'Failed to reorder channels');
      showToast(errorMsg, 'error');
      setSlotOrder([...originalOrder.current]);
    } finally {
      setIsReordering(false);
    }
  };

  const handleCancelReorder = () => {
    setSlotOrder([...originalOrder.current]);
  };

  // Auto-position channel: lowest-index channel with positionPrecision > 0
  const autoPositionChannelId = useMemo(() => {
    const sorted = channels
      .filter(ch => (ch.positionPrecision ?? 0) > 0)
      .sort((a, b) => a.id - b.id);
    return sorted.length > 0 ? sorted[0].id : null;
  }, [channels]);

  // Configured slots, in the current drag order.
  const visibleSlots = slotOrder.filter(slot => isConfigured(channelBySlot.get(slot)));

  // The lowest slot without a channel; null when all eight are in use.
  const nextFreeSlot = useMemo(() => {
    for (const slot of ALL_SLOTS) if (!isConfigured(channelBySlot.get(slot))) return slot;
    return null;
  }, [channelBySlot]);

  const openEditor = (slotId: number, isNew: boolean) => {
    const ch = channelBySlot.get(slotId);
    let draft: ChannelDraft;
    if (isNew) {
      draft = {
        name: `Channel ${slotId}`,
        // A new channel starts with its own random key rather than whatever
        // the disabled slot last held.
        psk: generateChannelKey(PSK_GENERATE_BYTES, 'base64'),
        role: slotId === 0 ? 1 : 2,
        uplinkEnabled: false,
        downlinkEnabled: false,
        positionPrecision: 0,
      };
    } else {
      draft = {
        name: ch?.name ?? '',
        // The "encryption off" key shows as an empty field, which is how the
        // user asked for it (#5826).
        psk: ch?.psk === NO_ENCRYPTION_PSK ? '' : (ch?.psk ?? ''),
        role: ch?.role ?? (slotId === 0 ? 1 : 2),
        uplinkEnabled: ch?.uplinkEnabled ?? true,
        downlinkEnabled: ch?.downlinkEnabled ?? true,
        positionPrecision: ch?.positionPrecision ?? 32,
      };
    }
    setEditing({ slotId, isNew, draft, original: draft });
  };

  const updateDraft = (patch: Partial<ChannelDraft>) => {
    setEditing(prev => (prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev));
  };

  const keyValid = !!editing && isValidChannelKey(editing.draft.psk, 'base64', PSK_ALLOWED_BYTES);

  // One set_channel write for this card, and only on an explicit click.
  const handleSaveChannel = async () => {
    if (!editing || !keyValid) return;
    const { slotId, draft } = editing;
    if (draft.name.length > MAX_NAME_LENGTH) {
      showToast(t('channels_config.toast_name_too_long'), 'error');
      return;
    }
    setIsSaving(true);
    try {
      await apiService.updateChannel(slotId, {
        name: draft.name,
        psk: pskForSave(editing),
        role: draft.role,
        uplinkEnabled: draft.uplinkEnabled,
        downlinkEnabled: draft.downlinkEnabled,
        positionPrecision: draft.positionPrecision
      }, sourceId);
      showToast(t('channels_config.toast_channel_updated', { slot: slotId }), 'success');
      setEditing(null);
      onChannelsUpdated?.();
    } catch (error) {
      logger.error('Error updating channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channels_config.toast_update_failed');
      showToast(errorMsg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteChannel = async (slotId: number) => {
    // Channel 0 (Primary) cannot be deleted
    if (slotId === 0) {
      showToast(t('channels_config.toast_cannot_delete_primary', 'Cannot delete the primary channel'), 'error');
      return;
    }
    if (editing?.slotId === slotId) setEditing(null);
    try {
      // 1. Disable channel on the device
      await apiService.updateChannel(slotId, {
        name: '',
        psk: '',
        role: 0, // DISABLED
        uplinkEnabled: false,
        downlinkEnabled: false,
      }, sourceId);
      // 2. Delete channel record and messages from database
      try {
        // The route requires sourceId; without it the 400 was swallowed below
        // and the row and its messages were never removed (#5324).
        if (sourceId) {
          await apiService.delete(`/api/channels/${slotId}?sourceId=${encodeURIComponent(sourceId)}`);
        }
      } catch {
        // DB cleanup is best-effort — channel is already disabled on device
      }
      showToast(t('channels_config.toast_channel_deleted', { slot: slotId }), 'success');
      onChannelsUpdated?.();
    } catch (error) {
      logger.error('Error deleting channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channels_config.toast_delete_failed', 'Failed to delete channel');
      showToast(errorMsg, 'error');
    }
  };

  const handleExportChannel = async (channelId: number) => {
    try {
      await apiService.exportChannel(channelId, sourceId);
      showToast(t('channels_config.toast_channel_exported', { slot: channelId }), 'success');
    } catch (error) {
      logger.error('Error exporting channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channels_config.toast_export_failed');
      showToast(errorMsg, 'error');
    }
  };

  const handleImportClick = (slotId: number) => {
    setImportSlotId(slotId);
    setImportFileContent('');
    setShowImportModal(true);
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImportFileContent(e.target?.result as string);
    };
    reader.readAsText(file);
  };

  const handleImportChannel = async () => {
    if (!importFileContent) {
      showToast(t('channels_config.toast_select_file'), 'error');
      return;
    }
    setIsImporting(true);
    try {
      const importData = JSON.parse(importFileContent);
      if (!importData.channel) {
        throw new Error(t('channels_config.toast_invalid_format'));
      }
      // Normalize boolean values - handle both boolean (true/false) and numeric (1/0) formats
      const normalizeBoolean = (value: unknown, defaultValue: boolean = true): boolean => {
        if (value === undefined || value === null) return defaultValue;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
        return !!value;
      };
      const normalizedChannelData = {
        ...importData.channel,
        uplinkEnabled: normalizeBoolean(importData.channel.uplinkEnabled, true),
        downlinkEnabled: normalizeBoolean(importData.channel.downlinkEnabled, true)
      };
      await apiService.importChannel(importSlotId, normalizedChannelData, sourceId);
      showToast(t('channels_config.toast_channel_imported', { slot: importSlotId }), 'success');
      setShowImportModal(false);
      setImportFileContent('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      onChannelsUpdated?.();
    } catch (error) {
      logger.error('Error importing channel:', error);
      const errorMsg = error instanceof Error ? error.message : t('channels_config.toast_import_failed');
      showToast(errorMsg, 'error');
    } finally {
      setIsImporting(false);
    }
  };

  const reorderBlockReason = hasReorderChanges
    ? t('channels_config.reorder_blocks_edit', 'Apply or cancel the new channel order first.')
    : undefined;

  const renderEditor = (edit: EditingState) => (
    <>
      <div className="setting-item">
        <label htmlFor="edit-channel-name">
          {t('channels_config.channel_name')}
          <span className="setting-description">{t('channels_config.channel_name_description')}</span>
        </label>
        <input
          id="edit-channel-name"
          type="text"
          maxLength={MAX_NAME_LENGTH}
          value={edit.draft.name}
          onChange={(e) => updateDraft({ name: e.target.value })}
          className="setting-input"
          placeholder={t('channels_config.channel_name_placeholder')}
        />
      </div>

      <ChannelKeyField
        id="edit-channel-psk"
        label={t('channels_config.psk')}
        description={t('channels_config.psk_description')}
        value={edit.draft.psk}
        onChange={(psk) => updateDraft({ psk })}
        format="base64"
        generateBytes={PSK_GENERATE_BYTES}
        allowedBytes={PSK_ALLOWED_BYTES}
        invalidMessage={t('channels_config.psk_invalid', 'Enter a base64 key of 1, 16 or 32 bytes, or leave it empty for no encryption.')}
        placeholder={t('channels_config.psk_placeholder')}
      />

      <div className="setting-item">
        <label htmlFor="edit-channel-role">
          {t('channels_config.channel_role')}
          <span className="setting-description">{t('channels_config.channel_role_description')}</span>
        </label>
        <select
          id="edit-channel-role"
          value={edit.draft.role}
          onChange={(e) => updateDraft({ role: parseInt(e.target.value, 10) })}
          className="setting-input"
        >
          <option value={0}>{t('channels_config.role_disabled')}</option>
          <option value={1}>{t('channels_config.role_primary')}</option>
          <option value={2}>{t('channels_config.role_secondary')}</option>
        </select>
      </div>

      <div className="setting-item">
        <label htmlFor="edit-channel-precision">
          {t('channels_config.position_precision')}
          <span className="setting-description">{t('channels_config.position_precision_description')}</span>
        </label>
        <NumberInput
          id="edit-channel-precision"
          min={0}
          max={32}
          integer
          value={edit.draft.positionPrecision}
          onChange={(value) => updateDraft({ positionPrecision: value })}
          className="setting-input"
          placeholder="32"
        />
        <span className={`setting-description ${styles.accuracy}`}>
          {t('channels_config.estimated_accuracy', { accuracy: formatPrecisionAccuracy(edit.draft.positionPrecision, distanceUnit) })}
        </span>
      </div>

      <div className="setting-item">
        <label className={styles.checkLabel}>
          <span className={styles.checkRow}>
            <input
              type="checkbox"
              checked={edit.draft.uplinkEnabled}
              onChange={(e) => updateDraft({ uplinkEnabled: e.target.checked })}
            />
            <span>{t('channels_config.uplink_enabled')}</span>
          </span>
          <span className={`setting-description ${styles.checkDescription}`}>{t('channels_config.uplink_description')}</span>
        </label>
      </div>

      <div className="setting-item">
        <label className={styles.checkLabel}>
          <span className={styles.checkRow}>
            <input
              type="checkbox"
              checked={edit.draft.downlinkEnabled}
              onChange={(e) => updateDraft({ downlinkEnabled: e.target.checked })}
            />
            <span>{t('channels_config.downlink_enabled')}</span>
          </span>
          <span className={`setting-description ${styles.checkDescription}`}>{t('channels_config.downlink_description')}</span>
        </label>
      </div>
    </>
  );

  const renderFooter = (edit: EditingState) => ({ numberInvalid }: { numberInvalid: boolean }) => (
    <>
      <ConfigItemCardButton onClick={() => setEditing(null)} disabled={isSaving}>
        {t('common.cancel', 'Cancel')}
      </ConfigItemCardButton>
      <ConfigItemCardButton
        variant="primary"
        onClick={() => { void handleSaveChannel(); }}
        disabled={isSaving || numberInvalid || !keyValid || (!edit.isNew && !dirty)}
      >
        <UiIcon name="save" size={14} />
        {isSaving ? t('common.saving', 'Saving...') : t('channels_config.save_to_device', 'Save to device')}
      </ConfigItemCardButton>
    </>
  );

  const chipsFor = (channel: Channel, slotId: number, displaySlot: number): ConfigItemChip[] => {
    const chips: ConfigItemChip[] = [
      { label: <ChannelEncryptionLabel status={channelEncryptionStatus(channel)} /> },
    ];
    const isPrimary = hasReorderChanges ? displaySlot === 0 : channel.role === 1;
    chips.push(isPrimary
      ? { label: <><UiIcon name="favorite" size={12} /> {t('channels_config.primary')}</>, tone: 'accent' }
      : { label: t('channels_config.role_secondary') });
    if (channel.uplinkEnabled) {
      chips.push({ label: <><UiIcon name="sortAscending" size={12} /> {t('channels_config.uplink')}</>, tone: 'info' });
    }
    if (channel.downlinkEnabled) {
      chips.push({ label: <><UiIcon name="sortDescending" size={12} /> {t('channels_config.downlink')}</>, tone: 'info' });
    }
    if ((channel.positionPrecision ?? 0) > 0) {
      const auto = slotId === autoPositionChannelId;
      chips.push({
        label: (
          <>
            <UiIcon name={auto ? 'location' : 'pin'} size={12} />{' '}
            {auto ? t('channels_config.location_auto_broadcast') : t('channels_config.location_enabled')}
            {` (${formatPrecisionAccuracy(channel.positionPrecision ?? 0, distanceUnit)})`}
          </>
        ),
      });
    }
    return chips;
  };

  return (
    <>
      <ConfigSection
        title={t('channels_config.title')}
        docsUrl="https://meshtastic.org/docs/configuration/radio/channels/"
        description={t('channels_config.description')}
        canWrite={canWrite}
      >
        {/* Reorder action bar */}
        {hasReorderChanges && (
          <div className={styles.reorderBar}>
            <span className={styles.reorderText}>
              {t('channels_config.reorder_pending', 'Channel order changed. Apply to device?')}
            </span>
            <ConfigItemCardButton variant="primary" onClick={() => { void handleApplyReorder(); }} disabled={isReordering}>
              {isReordering ? t('common.saving', 'Saving...') : t('channels_config.apply_order', 'Apply Order')}
            </ConfigItemCardButton>
            <ConfigItemCardButton onClick={handleCancelReorder} disabled={isReordering}>
              {t('common.cancel', 'Cancel')}
            </ConfigItemCardButton>
          </div>
        )}

        {visibleSlots.length === 0 && !editing?.isNew && (
          <p className={styles.empty}>{t('channels_config.no_channels', 'No channels are configured.')}</p>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <SortableContext items={visibleSlots} strategy={verticalListSortingStrategy}>
            <div className={styles.list}>
              {visibleSlots.map(slotId => {
                const channel = channelBySlot.get(slotId)!;
                const displaySlot = slotOrder.indexOf(slotId);
                const isEditing = editing !== null && !editing.isNew && editing.slotId === slotId;
                const collisions = collisionDbNamesByChannelId.get(channel.id);
                return (
                  <SortableChannelCard
                    key={slotId}
                    id={slotId}
                    disabled={!canWrite || editing !== null}
                    dragLabel={t('channels_config.drag_to_reorder', 'Drag to reorder')}
                  >
                    <ConfigItemCard
                      testId="channel-card"
                      leading={t('channels_config.slot', { slot: hasReorderChanges ? displaySlot : slotId })}
                      title={
                        <>
                          {channel.name || <span className={styles.unnamed}>{t('channels_config.unnamed')}</span>}
                          <AeadBadge useAead={channel.useAead} />
                        </>
                      }
                      chips={chipsFor(channel, slotId, displaySlot)}
                      highlighted={hasReorderChanges ? displaySlot === 0 : channel.role === 1}
                      notice={collisions && (
                        <span title={t('channels_config.collision_tooltip', 'This channel shares its encryption key with a Channel Database (server-side decryption) entry under a different name, so its messages are filed under that entry instead.')}>
                          <UiIcon name="alert" size={12} /> {t('channels_config.collision_warning', {
                            defaultValue: 'Key shared with Channel Database entry "{{names}}" — messages may appear under that name instead of here.',
                            names: collisions.join('", "'),
                          })}
                        </span>
                      )}
                      expanded={isEditing}
                      disabled={!canWrite}
                      editDisabled={hasReorderChanges}
                      editTitle={reorderBlockReason}
                      onEdit={() => discard.guard(() => openEditor(slotId, false))}
                      onDelete={slotId > 0 && !hasReorderChanges ? () => { void handleDeleteChannel(slotId); } : undefined}
                      deleteTitle={t('channels_config.delete_title', 'Delete channel {{slot}}?', { slot: slotId })}
                      deleteMessage={t(
                        'channels_config.delete_message',
                        'This disables the channel on the device and permanently deletes its message history in MeshMonitor. The messages cannot be recovered.',
                      )}
                      deletePreview={channel.name || t('channels_config.unnamed')}
                      deleteConfirmLabel={t('channels_config.delete_confirm', 'Delete channel and messages')}
                      actions={
                        <>
                          <ConfigItemCardButton onClick={() => { void handleExportChannel(slotId); }} disabled={!canWrite}>
                            <UiIcon name="download" size={14} /> {t('common.export')}
                          </ConfigItemCardButton>
                          <ConfigItemCardButton
                            onClick={() => discard.guard(() => { setEditing(null); handleImportClick(slotId); })}
                            disabled={!canWrite || hasReorderChanges}
                            title={reorderBlockReason}
                          >
                            <UiIcon name="upload" size={14} /> {t('common.import')}
                          </ConfigItemCardButton>
                        </>
                      }
                      footer={isEditing && editing ? renderFooter(editing) : undefined}
                    >
                      {isEditing && editing && renderEditor(editing)}
                    </ConfigItemCard>
                  </SortableChannelCard>
                );
              })}
            </div>
          </SortableContext>
          <DragOverlay>
            {activeDragId !== null && (() => {
              const ch = channelBySlot.get(activeDragId);
              return (
                <div className={styles.dragPreview}>
                  {ch?.name || t('channels_config.unnamed')}
                </div>
              );
            })()}
          </DragOverlay>
        </DndContext>

        {editing?.isNew && (
          <ConfigItemCard
            testId="channel-card-new"
            leading={t('channels_config.slot', { slot: editing.slotId })}
            title={t('channels_config.new_channel', 'New channel')}
            expanded
            footer={renderFooter(editing)}
          >
            {renderEditor(editing)}
          </ConfigItemCard>
        )}

        <div className={styles.addBar}>
          <ConfigItemCardButton
            onClick={() => {
              if (nextFreeSlot !== null) discard.guard(() => openEditor(nextFreeSlot, true));
            }}
            disabled={!canWrite || nextFreeSlot === null || hasReorderChanges || !!editing?.isNew}
            title={nextFreeSlot === null
              ? t('channels_config.add_channel_full', 'All 8 channel slots are in use. Delete a channel to free a slot.')
              : reorderBlockReason}
            data-testid="channel-add"
          >
            <UiIcon name="plus" size={14} />
            {nextFreeSlot === null
              ? t('channels_config.add_channel', 'Add channel')
              : t('channels_config.add_channel_slot', 'Add channel (slot {{slot}})', { slot: nextFreeSlot })}
          </ConfigItemCardButton>
          {nextFreeSlot !== null && (
            <ConfigItemCardButton
              onClick={() => discard.guard(() => { setEditing(null); handleImportClick(nextFreeSlot); })}
              disabled={!canWrite || hasReorderChanges}
              title={reorderBlockReason}
            >
              <UiIcon name="upload" size={14} />
              {t('channels_config.import_to_slot', 'Import to slot {{slot}}', { slot: nextFreeSlot })}
            </ConfigItemCardButton>
          )}
          {nextFreeSlot === null && (
            <span className={styles.addReason}>
              {t('channels_config.add_channel_full', 'All 8 channel slots are in use. Delete a channel to free a slot.')}
            </span>
          )}
        </div>
      </ConfigSection>

      <DiscardChangesDialog guard={discard} />

      <Modal
        isOpen={showImportModal}
        onClose={() => { if (!isImporting) setShowImportModal(false); }}
        title={t('channels_config.import_channel', { slot: importSlotId })}
      >
        <div className="setting-item">
          <label htmlFor="import-file">
            {t('channels_config.select_file')}
            <span className="setting-description">{t('channels_config.select_file_description')}</span>
          </label>
          <input
            ref={fileInputRef}
            id="import-file"
            type="file"
            accept=".json"
            onChange={handleFileSelect}
            className={styles.fileInput}
          />
        </div>

        {importFileContent && (
          <div className={styles.previewBlock}>
            <label>{t('channels_config.preview')}:</label>
            <pre className={styles.preview}>{importFileContent}</pre>
          </div>
        )}

        <div className={styles.modalActions}>
          <ConfigItemCardButton
            variant="primary"
            onClick={() => { void handleImportChannel(); }}
            disabled={isImporting || !importFileContent}
          >
            {isImporting ? t('channels_config.importing') : t('channels_config.import_channel_button')}
          </ConfigItemCardButton>
          <ConfigItemCardButton onClick={() => setShowImportModal(false)} disabled={isImporting}>
            {t('common.cancel')}
          </ConfigItemCardButton>
        </div>
      </Modal>
    </>
  );
};

export default ChannelsConfigSection;
