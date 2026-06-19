import { useEffect, useRef, useCallback } from 'react';
import { useSaveBarContext, useSaveBarGroup, SaveBarSection } from '../contexts/SaveBarContext';

export interface UseSaveBarOptions {
  id: string;
  sectionName: string;
  hasChanges: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
  onDismiss: () => void;
  /**
   * Optional grouping key. Defaults to the nearest <SaveBarGroup> in the tree.
   * Pass `null` to force this section to save individually even inside a group.
   */
  group?: string | null;
}

/**
 * Hook for components to register with the unified SaveBar.
 * When hasChanges is true, the SaveBar will appear allowing the user to save or dismiss changes.
 */
export const useSaveBar = (options: UseSaveBarOptions): void => {
  const { id, sectionName, hasChanges, isSaving, onSave, onDismiss } = options;
  const { registerSection, unregisterSection, updateSection, setActiveSection, activeSection } = useSaveBarContext();
  const inheritedGroup = useSaveBarGroup();
  // Resolve the group: an explicit option wins (including `null` to opt out of
  // an inherited group); otherwise inherit from the nearest <SaveBarGroup>.
  // Normalize `null` -> `undefined` so "no group" has a single representation.
  let group: string | undefined;
  if (options.group !== undefined) {
    group = options.group ?? undefined; // explicit `null` => no group
  } else {
    group = inheritedGroup ?? undefined; // inherit, `null` => no group
  }

  // Store callbacks in refs to avoid triggering effects on callback identity changes
  const onSaveRef = useRef(onSave);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  // Stable wrappers that use refs
  const stableOnSave = useCallback(async () => {
    await onSaveRef.current();
  }, []);

  const stableOnDismiss = useCallback(() => {
    onDismissRef.current();
  }, []);

  // Register section on mount, unregister on unmount
  useEffect(() => {
    const section: SaveBarSection = {
      id,
      sectionName,
      hasChanges,
      isSaving,
      onSave: stableOnSave,
      onDismiss: stableOnDismiss,
      group
    };
    registerSection(section);

    return () => {
      unregisterSection(id);
    };
  }, [id, sectionName, group, registerSection, unregisterSection, stableOnSave, stableOnDismiss]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update hasChanges and isSaving when they change
  useEffect(() => {
    updateSection(id, { hasChanges, isSaving });
  }, [id, hasChanges, isSaving, updateSection]);

  // Auto-select this section when it has changes and nothing else is selected
  useEffect(() => {
    if (hasChanges && !activeSection) {
      setActiveSection(id);
    }
  }, [hasChanges, activeSection, id, setActiveSection]);
};
