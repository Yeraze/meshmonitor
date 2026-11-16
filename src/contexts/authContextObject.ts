import { createContext } from 'react';
import type { AuthContextType } from './AuthContext';

/**
 * The auth context object, kept apart from AuthContext.tsx so a hook that only
 * reads it (usePublicInstanceView) still works when a test replaces that
 * module with a partial mock.
 */
export const AuthContext = createContext<AuthContextType | undefined>(undefined);
