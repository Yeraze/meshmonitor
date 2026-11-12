import type { UiIconName } from './icons';

/**
 * One entry in the composer's + menu (#6370). The menu is protocol-neutral:
 * a caller (today the MeshCore channel and DM views) supplies the entries.
 */
export interface ComposeInsertMenuItem {
  id: string;
  label: string;
  icon?: UiIconName;
  disabled?: boolean;
  /** Shown as the entry's tooltip and hint while it is disabled. */
  disabledReason?: string;
  /**
   * Runs when the entry is picked. `insert` puts text at the compose box's
   * caret; call it now, or keep it and call it later (after a picker closes).
   */
  onSelect: (insert: (text: string) => void) => void;
}
