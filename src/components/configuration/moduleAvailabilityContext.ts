import { createContext } from 'react';

/**
 * Set by ModuleAvailabilityGate only when the device's firmware build excluded
 * the module (#5065). ModuleAvailabilityNotice reads it so each section can
 * place the notice under its own header (#5447).
 */
export interface ModuleAvailabilityContextValue {
  moduleName: string;
}

export const ModuleAvailabilityContext = createContext<ModuleAvailabilityContextValue | null>(null);
