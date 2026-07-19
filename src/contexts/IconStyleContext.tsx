import { createContext, useContext, type ReactNode } from 'react';

export type IconStyle = 'lucide' | 'emoji';

const IconStyleContext = createContext<IconStyle | undefined>(undefined);

export function IconStyleProvider({ value, children }: { value: IconStyle; children: ReactNode }) {
  return <IconStyleContext.Provider value={value}>{children}</IconStyleContext.Provider>;
}

/** Lightweight optional hook for leaf icons; defaults are chosen by UiIcon. */
// eslint-disable-next-line react-refresh/only-export-components -- #4215 lightweight hook intentionally shares its tiny context module
export function useIconStyleOptional(): IconStyle | undefined {
  return useContext(IconStyleContext);
}
