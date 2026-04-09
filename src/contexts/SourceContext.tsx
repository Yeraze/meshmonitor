/**
 * Source Context
 *
 * Provides the active sourceId to all child components when viewing a specific
 * source in the multi-source navigation tree (/source/:sourceId/*).
 * When sourceId is null, components use the default / legacy behavior.
 */

import React, { createContext, useContext } from 'react';

interface SourceContextType {
  /** The active source UUID, or null when not in a source-specific view */
  sourceId: string | null;
  /** Display name of the active source, or null */
  sourceName: string | null;
}

const SourceContext = createContext<SourceContextType>({
  sourceId: null,
  sourceName: null,
});

interface SourceProviderProps {
  sourceId: string;
  sourceName?: string | null;
  children: React.ReactNode;
}

export function SourceProvider({ sourceId, sourceName = null, children }: SourceProviderProps) {
  return (
    <SourceContext.Provider value={{ sourceId, sourceName }}>
      {children}
    </SourceContext.Provider>
  );
}

/**
 * Returns the active source context.
 * sourceId will be null when not inside a SourceProvider (legacy / single-source mode).
 */
export function useSource(): SourceContextType {
  return useContext(SourceContext);
}
