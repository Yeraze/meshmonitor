/**
 * The DataContext object, apart from its provider (DataContext.tsx), so a hook
 * that only reads it can live here without a .tsx file exporting non-components.
 */
import { createContext, useContext } from 'react';
import type { ConnectionStatus } from '../types/ui';
import type { DataContextType } from './DataContext';

export const DataContext = createContext<DataContextType | undefined>(undefined);

/**
 * App's connection state, or undefined outside a DataProvider. For usePoll(),
 * which runs both inside App and in places with no DataProvider.
 */
export const useOptionalConnectionStatus = (): ConnectionStatus | undefined =>
  useContext(DataContext)?.connectionStatus;
