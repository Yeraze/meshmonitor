/**
 * Stock quick-status presets for the header status pill (#5616).
 *
 * The list is fixed in code for v1: no per-user storage and no migration.
 *
 * The emoji is CONTENT, not interface chrome: it is sent to the node as part
 * of the status text and shown by every other client on the mesh. That is the
 * `UiIcon` rule's content exception, hence the lint disable below. The label is
 * translatable; the emoji stays with the preset.
 *
 * No preset may read as an emergency or SOS call. Real distress signalling is
 * a separate, gated feature (#5620), and a one-tap status must not look like a
 * second, ungated path to it. That is why the help preset says "non-urgent"
 * and does not use the SOS-sign emoji.
 */
export interface StatusPreset {
  id: string;
  emoji: string;
  /** i18n key under `quick_status.presets`. */
  labelKey: string;
  /** English fallback for the label. */
  defaultLabel: string;
}

/* eslint-disable meshmonitor-ui/no-hardcoded-ui-glyph -- #5616 preset content emoji */
export const STATUS_PRESETS: readonly StatusPreset[] = [
  { id: 'available', emoji: '🟢', labelKey: 'quick_status.presets.available', defaultLabel: 'Available' },
  { id: 'away', emoji: '🟡', labelKey: 'quick_status.presets.away', defaultLabel: 'Away' },
  { id: 'busy', emoji: '🔴', labelKey: 'quick_status.presets.busy', defaultLabel: 'Busy' },
  { id: 'sleeping', emoji: '💤', labelKey: 'quick_status.presets.sleeping', defaultLabel: 'Sleeping' },
  { id: 'driving', emoji: '🚗', labelKey: 'quick_status.presets.driving', defaultLabel: 'Driving' },
  { id: 'moving', emoji: '🏃', labelKey: 'quick_status.presets.moving', defaultLabel: 'On the move' },
  { id: 'home', emoji: '🏠', labelKey: 'quick_status.presets.home', defaultLabel: 'At home' },
  { id: 'monitoring', emoji: '📡', labelKey: 'quick_status.presets.monitoring', defaultLabel: 'Monitoring' },
  { id: 'testing', emoji: '🔧', labelKey: 'quick_status.presets.testing', defaultLabel: 'Testing' },
  { id: 'help', emoji: '🙋', labelKey: 'quick_status.presets.help', defaultLabel: 'Need help (non-urgent)' },
];
/* eslint-enable meshmonitor-ui/no-hardcoded-ui-glyph */

/** The status text a preset sends: its emoji, a space, then the label. */
export function presetStatusText(preset: StatusPreset, label: string): string {
  return `${preset.emoji} ${label}`;
}
