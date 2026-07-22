import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react';

export interface SaveBarSection {
  id: string;
  sectionName: string;
  hasChanges: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
  onDismiss: () => void;
  /**
   * Optional grouping key. Sections sharing a group are saved/dismissed together
   * by a single SaveBar action ("Save All"). Sections without a group are saved
   * individually (the default — e.g. Device Configuration, where each section is a
   * separate device admin write).
   */
  group?: string;
}

interface SaveBarContextType {
  sections: Map<string, SaveBarSection>;
  registerSection: (section: SaveBarSection) => void;
  unregisterSection: (id: string) => void;
  updateSection: (id: string, updates: Partial<SaveBarSection>) => void;
  activeSection: string | null;
  setActiveSection: (id: string | null) => void;
}

const SaveBarContext = createContext<SaveBarContextType | undefined>(undefined);

export const SaveBarProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [sections, setSections] = useState<Map<string, SaveBarSection>>(new Map());
  const [activeSection, setActiveSection] = useState<string | null>(null);

  const registerSection = useCallback((section: SaveBarSection) => {
    setSections(prev => {
      const next = new Map(prev);
      next.set(section.id, section);
      return next;
    });
  }, []);

  const unregisterSection = useCallback((id: string) => {
    setSections(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setActiveSection(current => current === id ? null : current);
  }, []);

  const updateSection = useCallback((id: string, updates: Partial<SaveBarSection>) => {
    setSections(prev => {
      const existing = prev.get(id);
      if (!existing) return prev;

      const next = new Map(prev);
      next.set(id, { ...existing, ...updates });
      return next;
    });
  }, []);

  const value = useMemo<SaveBarContextType>(() => ({
    sections,
    registerSection,
    unregisterSection,
    updateSection,
    activeSection,
    setActiveSection
  }), [sections, registerSection, unregisterSection, updateSection, activeSection, setActiveSection]);

  return (
    <SaveBarContext.Provider value={value}>
      {children}
    </SaveBarContext.Provider>
  );
};

export const useSaveBarContext = (): SaveBarContextType => {
  const context = useContext(SaveBarContext);
  if (!context) {
    throw new Error('useSaveBarContext must be used within a SaveBarProvider');
  }
  return context;
};

/**
 * Context carrying the active SaveBar group id for a region of the tree.
 * Sections rendered inside a <SaveBarGroup> inherit its id (unless they pass an
 * explicit `group` to useSaveBar). `null` means "no group" (per-section save).
 */
const SaveBarGroupContext = createContext<string | null>(null);

/**
 * Wraps a region whose SaveBar sections should be saved together with a single
 * "Save All" action. Used for Settings/Automation areas; Device Configuration is
 * intentionally left ungrouped so each section saves on its own.
 */
export const SaveBarGroup: React.FC<{ id: string; children: ReactNode }> = ({ id, children }) => (
  <SaveBarGroupContext.Provider value={id}>{children}</SaveBarGroupContext.Provider>
);

export const useSaveBarGroup = (): string | null => useContext(SaveBarGroupContext);
