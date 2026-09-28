import { createContext, useContext } from 'react';

/**
 * Set by ModuleAvailabilityGate only when the device's firmware build excluded
 * the module (#5065). ModuleAvailabilityNotice reads it so each section can
 * place the notice under its own header (#5447).
 */
export interface ModuleAvailabilityContextValue {
  moduleName: string;
}

export const ModuleAvailabilityContext = createContext<ModuleAvailabilityContextValue | null>(null);

/**
 * True when an enclosing ModuleAvailabilityGate has switched the section off.
 * A section with its own "unavailable" notice uses this to fold that notice
 * into the gate's one rather than stack two that say the same thing.
 */
export const useModuleExcluded = (): boolean => useContext(ModuleAvailabilityContext) !== null;
