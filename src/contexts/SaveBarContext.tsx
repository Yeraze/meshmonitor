import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface SaveBarSection {
  id: string;
  sectionName: string;
  hasChanges: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
  onDismiss: () => void;
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

  return (
    <SaveBarContext.Provider value={{
      sections,
      registerSection,
      unregisterSection,
      updateSection,
      activeSection,
      setActiveSection
    }}>
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
