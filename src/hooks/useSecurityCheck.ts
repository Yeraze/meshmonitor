/**
 * Hook for checking security configuration issues
 *
 * Checks for default admin password and other configuration issues
 * that should be addressed for security.
 */

import { useState, useEffect } from 'react';
import { logger } from '../utils/logger';

interface ConfigIssue {
  type: string;
  severity: 'warning' | 'error' | 'info';
  message: string;
  docsUrl: string;
}

interface SecurityCheckResult {
  /** Whether the admin account is using the default password */
  isDefaultPassword: boolean;
  /** List of configuration issues detected */
  configIssues: ConfigIssue[];
}

/**
 * Hook to check for security and configuration issues
 *
 * @param baseUrl - The base URL of the API
 * @param authFetch - Authenticated fetch function
 * @returns Security check state
 */
export function useSecurityCheck(
  baseUrl: string,
  authFetch: (url: string, options?: RequestInit) => Promise<Response>
): SecurityCheckResult {
  const [isDefaultPassword, setIsDefaultPassword] = useState(false);
  const [configIssues, setConfigIssues] = useState<ConfigIssue[]>([]);

  // Check for default admin password
  useEffect(() => {
    const checkDefaultPassword = async () => {
      try {
        const response = await authFetch(`${baseUrl}/api/auth/check-default-password`);
        if (response.ok) {
          const data = await response.json();
          setIsDefaultPassword(data.isDefaultPassword);
        }
      } catch (error) {
        logger.error('Error checking default password:', error);
      }
    };

    checkDefaultPassword();
  }, [baseUrl, authFetch]);

  // Check for configuration issues
  useEffect(() => {
    const checkConfigIssues = async () => {
      try {
        const response = await authFetch(`${baseUrl}/api/auth/check-config-issues`);
        if (response.ok) {
          const data = await response.json();
          setConfigIssues(data.issues || []);
        }
      } catch (error) {
        logger.error('Error checking config issues:', error);
      }
    };

    checkConfigIssues();
  }, [baseUrl, authFetch]);

  return {
    isDefaultPassword,
    configIssues,
  };
}
