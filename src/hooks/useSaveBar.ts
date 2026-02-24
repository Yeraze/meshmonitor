import { useEffect, useRef, useCallback } from 'react';
import { useSaveBarContext, SaveBarSection } from '../contexts/SaveBarContext';

export interface UseSaveBarOptions {
  id: string;
  sectionName: string;
  hasChanges: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
  onDismiss: () => void;
}

/**
 * Hook for components to register with the unified SaveBar.
 * When hasChanges is true, the SaveBar will appear allowing the user to save or dismiss changes.
 */
export const useSaveBar = (options: UseSaveBarOptions): void => {
  const { id, sectionName, hasChanges, isSaving, onSave, onDismiss } = options;
  const { registerSection, unregisterSection, updateSection, setActiveSection, activeSection } = useSaveBarContext();

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
      onDismiss: stableOnDismiss
    };
    registerSection(section);

    return () => {
      unregisterSection(id);
    };
  }, [id, sectionName, registerSection, unregisterSection, stableOnSave, stableOnDismiss]); // eslint-disable-line react-hooks/exhaustive-deps

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
